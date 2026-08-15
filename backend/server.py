from fastapi import FastAPI, APIRouter, HTTPException, Depends, Request
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import asyncio
import os
import logging
from pathlib import Path
from pydantic import BaseModel, Field
import uuid
from datetime import datetime, timezone

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

app = FastAPI()
api_router = APIRouter(prefix="/api")

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def get_client_ip(request: Request) -> str:
    """Get client IP from request, handling proxies"""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"

# Import get_current_user for authentication
from core.deps import get_current_user
from core import regions

# Notes, events, reminders, accounts, and feedback (the core domain + its heavier workflows)
# live in their own modules - see backend/notes/, backend/events/, backend/reminders/,
# backend/accounts/, backend/feedback/ for schemas, validation, and persistence.


# ---- E2EE key escrow + first-party feature telemetry ----
# The server stores ONLY opaque wrapped-key blobs and metadata-only usage events.
# It never receives note plaintext or unwrapped encryption keys.
import json as _json

MAX_WRAPPED_BLOB_CHARS = 8192          # base64 wrapped DEK / salt -- generous cap
MAX_EVENT_NAME_CHARS = 64
MAX_EVENT_META_BYTES = 2048            # metadata only -- guards against note content


class WrappedKeyPut(BaseModel):
    wrapped_by_password: str           # DEK wrapped by password-derived KEK (base64)
    wrapped_by_recovery: str           # DEK wrapped by recovery-code-derived KEK (base64)
    kdf_salt: str                      # base64 salt for the password KEK
    recovery_salt: str                 # base64 salt for the recovery-code KEK
    kdf: str = "pbkdf2"
    kdf_params: dict = {}
    enc_version: int = 1


class WrappedKeyResponse(WrappedKeyPut):
    pass


class FeatureEvent(BaseModel):
    event: str
    meta: dict = {}


def _check_blob(name: str, value: str):
    if len(value) > MAX_WRAPPED_BLOB_CHARS:
        raise HTTPException(status_code=413, detail=f"{name} too large")


@api_router.put("/crypto/wrapped-key")
async def put_wrapped_key(body: WrappedKeyPut, current_user: dict = Depends(get_current_user)):
    """Store the user's wrapped Data Encryption Key blobs. Opaque to the server."""
    user_id = current_user.get("id") or str(current_user.get("_id", ""))
    for n, v in (("wrapped_by_password", body.wrapped_by_password),
                 ("wrapped_by_recovery", body.wrapped_by_recovery),
                 ("kdf_salt", body.kdf_salt),
                 ("recovery_salt", body.recovery_salt)):
        _check_blob(n, v)
    doc = body.model_dump()
    doc["user_id"] = user_id
    doc["updated_at"] = datetime.now(timezone.utc).isoformat()
    await db.user_keys.update_one({"user_id": user_id}, {"$set": doc}, upsert=True)
    return {"message": "stored"}


@api_router.get("/crypto/wrapped-key", response_model=WrappedKeyResponse)
async def get_wrapped_key(current_user: dict = Depends(get_current_user)):
    user_id = current_user.get("id") or str(current_user.get("_id", ""))
    doc = await db.user_keys.find_one(
        {"user_id": user_id}, {"_id": 0, "user_id": 0, "updated_at": 0}
    )
    if not doc:
        raise HTTPException(status_code=404, detail="No key escrow for this user")
    return WrappedKeyResponse(**doc)


@api_router.post("/events/feature")
async def record_feature_event(body: FeatureEvent, current_user: dict = Depends(get_current_user)):
    """Record a metadata-only feature-usage event for first-party MongoDB analytics.
    NEVER send note content here -- meta is size-capped to discourage it."""
    user_id = current_user.get("id") or str(current_user.get("_id", ""))
    if not body.event or len(body.event) > MAX_EVENT_NAME_CHARS:
        raise HTTPException(status_code=400, detail="Invalid event name")
    if len(_json.dumps(body.meta)) > MAX_EVENT_META_BYTES:
        raise HTTPException(status_code=400, detail="Event meta too large (metadata only)")
    await db.feature_events.insert_one({
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "event": body.event,
        "meta": body.meta,
        "ts": datetime.now(timezone.utc).isoformat(),
    })
    return {"ok": True}


# ---- Push notifications (device token registration; delivery pipeline lives in
# backend/reminders/, account erasure lives in backend/accounts/) ----

class PushTokenBody(BaseModel):
    token: str
    platform: str = "android"


@api_router.post("/push/register")
async def register_push_token(body: PushTokenBody, current_user: dict = Depends(get_current_user)):
    """Upsert a device push token for the current user (deduped on user_id + token)."""
    user_id = current_user.get("id") or str(current_user.get("_id", ""))
    if not body.token:
        raise HTTPException(status_code=400, detail="Missing token")
    await db.push_tokens.update_one(
        {"user_id": user_id, "token": body.token},
        {"$set": {
            "user_id": user_id,
            "token": body.token,
            "platform": body.platform,
            "active": True,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }},
        upsert=True,
    )
    return {"ok": True}


@api_router.post("/push/unregister")
async def unregister_push_token(body: PushTokenBody, current_user: dict = Depends(get_current_user)):
    """Mark a token inactive (e.g. on logout). Kept, not deleted, so late receipts still resolve."""
    user_id = current_user.get("id") or str(current_user.get("_id", ""))
    await db.push_tokens.update_one(
        {"user_id": user_id, "token": body.token},
        {"$set": {"active": False}},
    )
    return {"ok": True}


# ---- Transcription + AI text processing moved to textai/ (router registered below) ----


# ---- Health Check ----

@api_router.get("/health")
async def health_check():
    return {"status": "healthy", "timestamp": datetime.now(timezone.utc).isoformat()}


# Include auth router
from auth.router import router as auth_router
from auth.reset_password_page import router as reset_password_router
api_router.include_router(auth_router)
app.include_router(reset_password_router)

# Include notes/events/trips routers (the core domain - see backend/notes/, backend/events/,
# backend/trips/)
from notes.router import router as notes_router
from events.router import router as events_router
from trips.router import router as trips_router
api_router.include_router(notes_router)
api_router.include_router(events_router)
api_router.include_router(trips_router)

# Include reminders/accounts/feedback routers (extracted out of server.py - see
# backend/reminders/, backend/accounts/, backend/feedback/)
from reminders.router import router as reminders_router
from accounts.router import router as accounts_router
from feedback.router import router as feedback_router
api_router.include_router(reminders_router)
api_router.include_router(accounts_router)
api_router.include_router(feedback_router)

# Include Canva integration router (design import - see backend/canva/)
from canva.router import router as canva_router
api_router.include_router(canva_router)

# Include Daily Brew router (news headlines - see backend/dailybrew/)
from dailybrew.router import router as dailybrew_router
api_router.include_router(dailybrew_router)

from textai.router import router as textai_router
api_router.include_router(textai_router)

from attachments.router import router as attachments_router
api_router.include_router(attachments_router)


app.include_router(api_router)


# ---- Staging APK download ----
# Serve the built APK from this backend so the download link and the /api the app
# talks to share one origin/port (e.g. http://192.168.20.32:8765). The path is
# configurable via APK_DOWNLOAD_PATH; if the file is absent (e.g. on Railway) the
# routes 404, so this is harmless in deployments that don't ship the APK.
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse

APK_DOWNLOAD_PATH = os.getenv(
    "APK_DOWNLOAD_PATH", str(ROOT_DIR.parent / "frontend" / "nueco-staging.apk")
)
APK_DOWNLOAD_ROUTE = "/download/nueco-staging.apk"


@app.get("/download", response_class=HTMLResponse)
async def apk_download_page():
    if not os.path.isfile(APK_DOWNLOAD_PATH):
        raise HTTPException(status_code=404, detail="APK not available")
    size_mb = os.path.getsize(APK_DOWNLOAD_PATH) / (1024 * 1024)
    return f"""<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nueco staging</title>
<div style="font-family:-apple-system,sans-serif;max-width:480px;margin:48px auto;padding:0 20px;text-align:center">
  <h1 style="color:#D84315">Nueco - staging build</h1>
  <p>{size_mb:.0f} MB</p>
  <p><a href="{APK_DOWNLOAD_ROUTE}" style="display:inline-block;padding:16px 32px;background:#D84315;color:#fff;text-decoration:none;border-radius:12px;font-size:18px;font-weight:600">Download &amp; install APK</a></p>
  <p style="color:#78909C;font-size:14px">Enable “Install from unknown sources” when prompted.</p>
</div>"""


@app.api_route(APK_DOWNLOAD_ROUTE, methods=["GET", "HEAD"])
async def apk_download_file():
    if not os.path.isfile(APK_DOWNLOAD_PATH):
        raise HTTPException(status_code=404, detail="APK not available")
    return FileResponse(
        APK_DOWNLOAD_PATH,
        media_type="application/vnd.android.package-archive",
        filename=os.path.basename(APK_DOWNLOAD_PATH),
    )


# ---- Privacy policy ----
# Served from this backend (same origin as the API) rather than the nueco.app
# domain, which isn't wired to any web host today - only used for outbound email.
# The Settings screen's Privacy Policy link points here.
PRIVACY_POLICY_PATH = str(ROOT_DIR / "static" / "privacy.html")


@app.get("/privacy", response_class=HTMLResponse)
async def privacy_policy_page():
    if not os.path.isfile(PRIVACY_POLICY_PATH):
        raise HTTPException(status_code=404, detail="Privacy policy not available")
    with open(PRIVACY_POLICY_PATH, "r", encoding="utf-8") as f:
        return f.read()


# ---- Terms of use ----
# Same pattern as the privacy policy above: served from this backend, draft-flagged in the
# HTML itself pending legal review (see backend/static/terms.html's banner).
TERMS_OF_USE_PATH = str(ROOT_DIR / "static" / "terms.html")


@app.get("/terms", response_class=HTMLResponse)
async def terms_of_use_page():
    if not os.path.isfile(TERMS_OF_USE_PATH):
        raise HTTPException(status_code=404, detail="Terms of use not available")
    with open(TERMS_OF_USE_PATH, "r", encoding="utf-8") as f:
        return f.read()


# ---- robots.txt ----
ROBOTS_TXT_PATH = str(ROOT_DIR / "static" / "robots.txt")


@app.get("/robots.txt", response_class=PlainTextResponse)
async def robots_txt():
    if not os.path.isfile(ROBOTS_TXT_PATH):
        raise HTTPException(status_code=404, detail="robots.txt not available")
    with open(ROBOTS_TXT_PATH, "r", encoding="utf-8") as f:
        return f.read()


# ---- Android App Links verification ----
# Required by Android's autoVerify (intentFilter in app.json). Without this file
# at exactly this path the OS marks the domain as unverified and deep links show
# a disambiguation dialog instead of opening the app directly.
ASSETLINKS_PATH = str(ROOT_DIR / "static" / "assetlinks.json")


@app.api_route("/.well-known/assetlinks.json", methods=["GET", "HEAD"], response_class=JSONResponse)
async def assetlinks():
    if not os.path.isfile(ASSETLINKS_PATH):
        raise HTTPException(status_code=404, detail="assetlinks.json not available")
    with open(ASSETLINKS_PATH, "r", encoding="utf-8") as f:
        # no-store so intermediary caches (incl. Google's fetch edge) never serve a stale copy
        return JSONResponse(content=_json.load(f), headers={"Cache-Control": "no-store"})


# ---- Anti-AI-training / anti-scraping posture ----
# Best-effort signals only - a non-compliant crawler can ignore robots.txt and spoof its
# User-Agent, so this deters well-behaved bots (which currently includes GPTBot, Google-Extended,
# ClaudeBot, CCBot, etc.) rather than guaranteeing anything. See plan doc's addendum for the
# full honesty check on what this can't do (App Store listings, APK decompilation).
AI_CRAWLER_USER_AGENTS = [
    "gptbot", "chatgpt-user", "ccbot", "google-extended", "applebot-extended",
    "claudebot", "anthropic-ai", "claude-web", "bytespider", "perplexitybot",
    "diffbot", "amazonbot", "cohere-ai", "omgili", "youbot",
]


@app.middleware("http")
async def block_ai_crawlers_and_tag_responses(request: Request, call_next):
    # /.well-known/ must stay machine-readable: Android App Links verification and the
    # Play Console checker fetch assetlinks.json here and reject noindex'd or blocked responses.
    if request.url.path.startswith("/.well-known/"):
        return await call_next(request)
    ua = request.headers.get("user-agent", "").lower()
    if any(bot in ua for bot in AI_CRAWLER_USER_AGENTS):
        return PlainTextResponse("Not available to automated crawlers.", status_code=403)
    response = await call_next(request)
    response.headers["X-Robots-Tag"] = "noai, noimageai, noindex"
    return response


# ---- CORS Configuration ----
# For production, specify exact origins instead of ["*"]
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "").split(",") if os.getenv("ALLOWED_ORIGINS") else []

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=ALLOWED_ORIGINS if ALLOWED_ORIGINS and ALLOWED_ORIGINS[0] else ["*"],
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Requested-With"],
)


# ---- Data residency gate ----
# Registered FIRST among startup handlers so it runs before index creation, cache
# prewarmers, and sweepers. Every external-service endpoint and region declaration
# must be present and Australian before a single request is served (Privacy Act 1988
# / APP 11); validate_all() raises and aborts the boot otherwise.
@app.on_event("startup")
async def enforce_data_residency():
    regions.validate_all()
    logger.info("[region-check] all external-service endpoints and region declarations validated against the AU allowlist")


# ---- Database Indexes ----
@app.on_event("startup")
async def create_indexes():
    """Create database indexes for optimal query performance"""
    try:
        # Drop problematic/superseded indexes first
        try:
            await db.users.drop_index("email_1")
        except:
            pass
        # Superseded by the (user_id, is_pinned, updated_at) compound index below - a
        # create_index() call for a superseded index disappearing from this function doesn't
        # drop it from an already-deployed database, so it must be dropped explicitly or it
        # lingers forever (dead weight on every notes write).
        for stale_index in ("user_id_1_updated_at_-1", "user_id_1_is_pinned_-1"):
            try:
                await db.notes.drop_index(stale_index)
            except:
                pass

        # Notes indexes
        # Matches notes/service.py's list() query+sort exactly (filter on user_id, sort by
        # is_pinned desc then updated_at desc) so pagination is fully index-covered instead of
        # falling back to a blocking in-memory sort. Replaces the two separate single-purpose
        # (user_id, updated_at) and (user_id, is_pinned) indexes this superseded - neither was
        # used by any other query, and a compound index's prefix (user_id, is_pinned) already
        # covers what a user_id+is_pinned-only query would need.
        await db.notes.create_index([("user_id", 1), ("is_pinned", -1), ("updated_at", -1)])
        # Superset of the index above, matching list()'s sort once `id` was added as a paging
        # tiebreaker (see notes/service.py's list()). The 3-key version is deliberately left in
        # place rather than dropped: during a rolling deploy an older instance still sorts without
        # the tiebreaker, and dropping its index would push that instance onto a blocking
        # in-memory sort of image-bearing notes - the exact failure the compound index exists to
        # prevent. Safe to drop once no pre-tiebreaker build is serving.
        await db.notes.create_index([("user_id", 1), ("is_pinned", -1), ("updated_at", -1), ("id", 1)])
        await db.notes.create_index([("user_id", 1), ("id", 1)])
        await db.notes.create_index([("user_id", 1), ("has_attachments", 1)])
        
        # Events indexes
        await db.events.create_index([("user_id", 1), ("start_time", 1)])
        # Covers list()'s (start_time, id) paging sort - same tiebreaker rationale as notes above.
        await db.events.create_index([("user_id", 1), ("start_time", 1), ("id", 1)])
        await db.events.create_index([("user_id", 1), ("id", 1)])
        await db.events.create_index("id")
        # Reminder scheduler: PARTIAL index over only the small pending subset (the vast majority of
        # historical events are 'sent'), so the per-minute tick query stays fast + small.
        await db.events.create_index(
            [("reminder_status", 1), ("reminder_fire_at", 1)],
            partialFilterExpression={"reminder_status": "pending"},
        )
        # Trip timeline lookups (an event's own trip_id) and the cascade-unset on trip delete
        # (trips/service.py's delete()) both filter on this pair.
        await db.events.create_index([("trip_id", 1), ("user_id", 1)])

        # Trips indexes
        await db.trips.create_index([("user_id", 1), ("created_at", -1)])
        # Covers list()'s (created_at, id) paging sort - same tiebreaker rationale as notes above.
        await db.trips.create_index([("user_id", 1), ("created_at", -1), ("id", 1)])
        await db.trips.create_index([("user_id", 1), ("id", 1)])

        # Push token indexes (reminder fire looks up the owner's active tokens on every send)
        await db.push_tokens.create_index([("user_id", 1), ("active", 1)])
        await db.push_tokens.create_index("token")
        await db.push_receipts.create_index([("checked", 1), ("created_at", 1)])
        
        # Users indexes
        await db.users.create_index("email", unique=True, sparse=True)
        await db.users.create_index("id", unique=True, sparse=True)
        
        # Sessions indexes with TTL
        await db.sessions.create_index("expires_at", expireAfterSeconds=0)
        await db.sessions.create_index("user_id")
        
        # Devices indexes
        await db.devices.create_index("user_id")

        # E2EE key escrow + first-party feature telemetry
        await db.user_keys.create_index("user_id", unique=True)
        await db.feature_events.create_index([("event", 1), ("ts", -1)])
        await db.feature_events.create_index([("user_id", 1), ("ts", -1)])

        # Shadow-mode transcription comparison records auto-expire after 7 days
        await db.transcription_shadow.create_index(
            "created_at", expireAfterSeconds=7 * 24 * 3600
        )

        logger.info("Database indexes created successfully")
    except Exception as e:
        logger.warning(f"Could not create indexes (may already exist): {e}")


@app.on_event("startup")
async def start_dailybrew_cache_prewarmer():
    from dailybrew.service import run_cache_prewarmer
    asyncio.create_task(run_cache_prewarmer())


@app.on_event("startup")
async def start_feature_flag_refresher():
    from featureflags import _refresh_flags, run_flag_refresher
    try:
        # Resolve once before serving traffic so the very first /auth/me response after a deploy
        # already has the real value instead of the fail-closed default.
        await asyncio.wait_for(_refresh_flags(), timeout=10.0)
    except Exception as e:
        logger.warning(f"Initial feature flag fetch failed, will retry in background: {e}")
    asyncio.create_task(run_flag_refresher())


@app.on_event("startup")
async def start_speechmatics_job_sweeper():
    # Reconciliation for the rare case where the inline job delete after transcription failed:
    # any Speechmatics job older than a few minutes is deleted, keeping provider-side audio
    # retention at minutes instead of the 7-day default. No-op unless Speechmatics is configured.
    from textai.transcription import run_speechmatics_sweeper
    asyncio.create_task(run_speechmatics_sweeper())


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
