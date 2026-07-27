from fastapi import FastAPI, APIRouter, HTTPException, Depends, Request
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import asyncio
import os
import logging
from pathlib import Path
from pydantic import BaseModel, Field
from typing import Optional
import uuid
from datetime import datetime, timezone, timedelta
import bcrypt
import httpx
from pymongo import ReturnDocument
from collections import defaultdict
import time

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

# ---- Rate Limiting ----
class RateLimiter:
    def __init__(self):
        self.requests = defaultdict(list)
    
    def is_allowed(self, key: str, max_requests: int, window_seconds: int) -> bool:
        now = time.time()
        # Clean old requests
        self.requests[key] = [t for t in self.requests[key] if now - t < window_seconds]
        
        if len(self.requests[key]) >= max_requests:
            return False
        
        self.requests[key].append(now)
        return True

rate_limiter = RateLimiter()


from openai_client import get_openai_client

def get_client_ip(request: Request) -> str:
    """Get client IP from request, handling proxies"""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"

# Import get_current_user for authentication
from auth.router import get_current_user

# S3-backed attachment storage lives in attachments/ - only the account-deletion
# cleanup hook is needed here (the embedded-in-a-note Attachment shape moved with
# NoteCreate/NoteUpdate/NoteResponse into notes/schemas.py).
from attachments.service import delete_user_attachments

# Notes and events (the core domain) live in their own modules - see backend/notes/
# and backend/events/ for schemas, validation, and persistence. Only the Recurrence
# schema and a few reminder-scheduling functions are still needed here, for push_tick.
from events.schemas import Recurrence
from events.service import compute_reminder_fields, next_occurrence_on_or_after, reminder_label


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


# ---- Account deletion (GDPR right to erasure) ----

class DeleteAccountRequest(BaseModel):
    password: str


@api_router.post("/account/delete")
async def delete_account(body: DeleteAccountRequest, current_user: dict = Depends(get_current_user)):
    """Permanently erase the authenticated user and ALL their data (GDPR Art. 17). Requires the
    account password as a confirmation. Irreversible."""
    user_id = current_user.get("id") or str(current_user.get("_id", ""))
    # Re-verify the password (fetch fresh so we always have the hash).
    user = await db.users.find_one({"id": user_id})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if not body.password or not bcrypt.checkpw(body.password.encode(), user.get("password", "").encode()):
        raise HTTPException(status_code=401, detail="Incorrect password")

    # Wipe object storage first (attachments), then every DB record tied to the user.
    # to_thread: delete_user_attachments uses sync boto3 (paginated list+delete over the S3
    # prefix) - called directly, it blocks the single uvicorn worker's event loop for the whole
    # walk, stalling every other in-flight request for however long a user's attachment count
    # takes to page through.
    await asyncio.to_thread(delete_user_attachments, user_id)
    for coll in ("notes", "events", "push_tokens", "push_receipts", "feature_events", "devices", "sessions"):
        try:
            await db[coll].delete_many({"user_id": user_id})
        except Exception as e:
            logger.error(f"Account delete: failed clearing {coll} for {user_id}: {e}")
    await db.users.delete_one({"id": user_id})
    logger.info(f"Account deleted (GDPR erasure): user {user_id}")
    return {"ok": True}


# ---- Push notifications (event reminders) ----

EXPO_PUSH_SEND_URL = "https://exp.host/--/api/v2/push/send"
EXPO_PUSH_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts"


def _expo_headers() -> dict:
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    token = os.environ.get("EXPO_ACCESS_TOKEN")  # optional but recommended for send security
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _require_tick_secret(request: Request):
    """Cron/internal endpoints are gated by a shared secret, not user auth."""
    secret = os.environ.get("PUSH_TICK_SECRET")
    if not secret or request.headers.get("X-Tick-Secret") != secret:
        raise HTTPException(status_code=403, detail="Forbidden")


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


@api_router.post("/internal/push/tick")
async def push_tick(request: Request):
    """Cron-driven (once/minute). Claims due reminders atomically, sends them via Expo in batches,
    handles per-item results, and records tickets for later receipt resolution. Recurring events
    (see `recurrence`/`timezone`) are additionally rolled forward to their next occurrence at the
    end - see step 5 below for why that step is restricted to this tick's own claimed batch."""
    _require_tick_secret(request)
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()

    # 1) Recover stuck claims - a prior tick crashed between claim and send. Return them to 'pending'.
    stuck_before = (now - timedelta(minutes=5)).isoformat()
    await db.events.update_many(
        {"reminder_status": "claimed", "reminder_claimed_at": {"$lt": stuck_before}},
        {"$set": {"reminder_status": "pending", "reminder_claimed_at": None}},
    )

    # 2) Atomically claim due, pending reminders (this is what stops overlapping ticks double-sending).
    claimed = []
    while len(claimed) < 500:
        ev = await db.events.find_one_and_update(
            {"reminder_minutes": {"$ne": None},
             "reminder_status": "pending",
             "reminder_fire_at": {"$lte": now_iso}},
            {"$set": {"reminder_status": "claimed", "reminder_claimed_at": now_iso}},
            return_document=ReturnDocument.AFTER,
        )
        if not ev:
            break
        claimed.append(ev)

    if not claimed:
        return {"claimed": 0, "sent": 0}

    # 3) Build one Expo message per (event, active token). No tokens -> the reminder is done.
    messages = []  # list of (event_id, token, message_dict)
    for ev in claimed:
        tokens = await db.push_tokens.find({"user_id": ev["user_id"], "active": True}).to_list(20)
        if not tokens:
            await db.events.update_one({"id": ev["id"]}, {"$set": {"reminder_status": "sent"}})
            continue
        # E2EE (Stage 5): an encrypted title is ciphertext to the server, so a reminder
        # push falls back to a generic title rather than showing garbled text. This is
        # a documented non-goal, not a bug - see docs/E2EE-DESIGN.md.
        push_title = 'Event Reminder' if ev.get('enc_version') else (ev.get('title') or 'Event Reminder')
        for t in tokens:
            messages.append((ev["id"], t["token"], {
                "to": t["token"],
                "title": f"⏰ {push_title}",
                "body": f"Starts in {reminder_label(ev.get('reminder_minutes'))}",
                "data": {"eventId": ev["id"], "kind": "event-reminder"},
                "sound": "default",
                "channelId": "event-reminders",
            }))

    # 4) Batch-send (<=100/call). Expo returns one result PER ITEM - walk them individually.
    processed_event_ids = set()  # events whose batch got any response -> move to 'sent'
    receipts = []
    async with httpx.AsyncClient(timeout=30) as http:
        for i in range(0, len(messages), 100):
            batch = messages[i:i + 100]
            try:
                resp = await http.post(EXPO_PUSH_SEND_URL, headers=_expo_headers(),
                                       json=[m for (_e, _t, m) in batch])
                results = resp.json().get("data", [])
            except Exception as e:
                # Whole call failed (rate limit / 5xx) - leave events 'claimed'; recovery retries.
                logger.error(f"Expo push send failed (batch left claimed): {e}")
                continue
            for (eid, token, _msg), result in zip(batch, results):
                processed_event_ids.add(eid)
                if result.get("status") == "ok" and result.get("id"):
                    receipts.append({"ticket_id": result["id"], "event_id": eid, "token": token,
                                     "created_at": now_iso, "checked": False})
                else:
                    err = (result.get("details") or {}).get("error")
                    if err == "DeviceNotRegistered":
                        await db.push_tokens.update_one({"token": token}, {"$set": {"active": False}})
                    logger.warning(f"Expo push item error: {result}")

    if processed_event_ids:
        await db.events.update_many({"id": {"$in": list(processed_event_ids)}},
                                    {"$set": {"reminder_status": "sent"}})

    # 5) Advance recurring reminders to their next occurrence.
    #
    # Operates ONLY on `claimed` - the exact in-memory list of event documents this
    # tick invocation atomically owned via the find_one_and_update loop in step 2
    # above. Deliberately NOT a fresh DB query (e.g. `find({"reminder_status": "sent"})`)
    # to find "the recurring ones to advance": every event in `claimed` is already
    # 'sent' by this point (either directly, in the no-active-tokens branch in step 3,
    # or via the bulk update just above), so re-querying by status would let a second,
    # overlapping tick match those same just-marked-sent events and race to advance
    # them too - a possible double-advance (skipping an occurrence) or write race.
    # The atomic claim in step 2 guarantees no two tick invocations ever claim the
    # same event id, so restricting this step to `claimed` makes that race
    # structurally impossible rather than merely unlikely. Each event is wrapped in
    # its own try/except so one bad/corrupt recurrence rule can only strand that one
    # event on terminal 'sent' (the same failure mode a non-recurring event already
    # has today) instead of aborting the rest of the batch.
    for ev in claimed:
        if not ev.get("recurrence"):
            continue  # non-recurring: already 'sent' above, byte-identical to pre-recurrence behavior
        try:
            recurrence = Recurrence(**ev["recurrence"])
            # +1s so we don't re-match the instant that just fired.
            next_dt = next_occurrence_on_or_after(
                ev.get("start_time"), recurrence, ev.get("timezone"), now + timedelta(seconds=1),
            )
            if next_dt is None:
                continue  # series ended (`until` passed, inclusive) - stays terminal 'sent'
            new_fire_at = next_dt - timedelta(minutes=ev["reminder_minutes"])
            await db.events.update_one(
                {"id": ev["id"]},
                {"$set": {
                    "reminder_status": "pending",
                    "reminder_fire_at": new_fire_at.isoformat(),
                    "reminder_claimed_at": None,
                }},
            )
        except Exception as e:
            logger.error(f"push_tick: failed to advance recurring event {ev.get('id')}: {e}")

    if receipts:
        await db.push_receipts.insert_many(receipts)
    return {"claimed": len(claimed), "sent": len(processed_event_ids), "tickets": len(receipts)}


@api_router.post("/internal/push/receipts")
async def push_receipts_tick(request: Request):
    """Cron-driven (~every 15-20 min). Resolves Expo delivery receipts; prunes tokens Expo reports
    as DeviceNotRegistered - the main way stale tokens (uninstall/reinstall) get cleaned up."""
    _require_tick_secret(request)
    now = datetime.now(timezone.utc)
    ready_before = (now - timedelta(minutes=15)).isoformat()   # receipts are ready ~15 min after send
    give_up_before = (now - timedelta(hours=24)).isoformat()   # stop chasing a receipt after 24h
    pending = await db.push_receipts.find(
        {"checked": False, "created_at": {"$lte": ready_before}}
    ).to_list(1000)
    if not pending:
        return {"checked": 0}

    checked = 0
    async with httpx.AsyncClient(timeout=30) as http:
        for i in range(0, len(pending), 300):
            batch = pending[i:i + 300]
            try:
                resp = await http.post(EXPO_PUSH_RECEIPTS_URL, headers=_expo_headers(),
                                       json={"ids": [r["ticket_id"] for r in batch]})
                data = resp.json().get("data", {})
            except Exception as e:
                logger.error(f"Expo getReceipts failed: {e}")
                continue
            for r in batch:
                rec = data.get(r["ticket_id"])
                if rec is None:
                    if r["created_at"] <= give_up_before:  # never resolved - stop chasing it
                        await db.push_receipts.update_one({"_id": r["_id"]}, {"$set": {"checked": True}})
                    continue
                if rec.get("status") == "error":
                    err = (rec.get("details") or {}).get("error")
                    if err == "DeviceNotRegistered":
                        await db.push_tokens.update_one({"token": r["token"]}, {"$set": {"active": False}})
                    else:
                        logger.warning(f"Push receipt error ({r['ticket_id']}): {rec}")
                await db.push_receipts.update_one({"_id": r["_id"]}, {"$set": {"checked": True}})
                checked += 1
    return {"checked": checked}


# ---- Transcription + AI text processing moved to textai/ (router registered below) ----


# ---- Feedback Endpoint (5th-note feedback toast) ----

MAX_FEEDBACK_TEXT_CHARS = 2000

class FeedbackCreate(BaseModel):
    sentiment: str  # "positive" | "negative"
    tag: Optional[str] = None
    text: str = ""
    note_count_at_submission: int = 0
    app_version: str = ""
    platform: str = ""


def _parse_ai_triage(raw: str) -> dict:
    """Best-effort parse of the triage model's JSON reply, tolerating a markdown code fence."""
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:]
    return _json.loads(cleaned)


@api_router.post("/feedback")
async def submit_feedback(body: FeedbackCreate, current_user: dict = Depends(get_current_user)):
    """Store a feedback-toast response, AI-triaging any free-text comment (never blocks the
    submission if triage fails -- the record is saved either way)."""
    user_id = current_user.get("id") or str(current_user.get("_id", ""))
    if body.sentiment not in ("positive", "negative"):
        raise HTTPException(status_code=400, detail="Invalid sentiment")
    if len(body.text) > MAX_FEEDBACK_TEXT_CHARS:
        raise HTTPException(status_code=400, detail="Feedback text too long")
    if not rate_limiter.is_allowed(f"feedback:{user_id}", max_requests=5, window_seconds=86400):
        raise HTTPException(status_code=429, detail="Too many feedback submissions, please try again later")

    doc = {
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "sentiment": body.sentiment,
        "tag": body.tag,
        "text": body.text,
        "aiCategory": None,
        "aiPriority": None,
        "aiSummary": None,
        "appVersion": body.app_version,
        "platform": body.platform,
        "noteCountAtSubmission": body.note_count_at_submission,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "status": "new",
    }

    if body.text.strip():
        try:
            client = get_openai_client()
            response = await client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "You triage user feedback for a note-taking app. Respond with ONLY "
                            'compact JSON: {"category": one of bug|feature_request|ux_friction|'
                            'praise|unclear, "priority": one of low|medium|high|urgent (urgent = '
                            'crash, data loss, or billing issue), "summary": a single short sentence}.'
                        ),
                    },
                    {"role": "user", "content": body.text},
                ],
                temperature=0.2,
            )
            parsed = _parse_ai_triage(response.choices[0].message.content or "")
            doc["aiCategory"] = parsed.get("category")
            doc["aiPriority"] = parsed.get("priority")
            doc["aiSummary"] = parsed.get("summary")
        except Exception as e:
            logger.error(f"Feedback AI triage failed: {e}")

    await db.feedback.insert_one(doc)
    return {"id": doc["id"], "status": "received"}


# ---- Health Check ----

@api_router.get("/health")
async def health_check():
    return {"status": "healthy", "timestamp": datetime.now(timezone.utc).isoformat()}


# Include auth router
from auth.router import router as auth_router
from auth.reset_password_page import router as reset_password_router
api_router.include_router(auth_router)
app.include_router(reset_password_router)

# Include notes/events routers (the core domain - see backend/notes/ and backend/events/)
from notes.router import router as notes_router
from events.router import router as events_router
api_router.include_router(notes_router)
api_router.include_router(events_router)

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
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse

APK_DOWNLOAD_PATH = os.getenv(
    "APK_DOWNLOAD_PATH", str(ROOT_DIR.parent / "frontend" / "memopad-staging.apk")
)
APK_DOWNLOAD_ROUTE = "/download/memopad-staging.apk"


@app.get("/download", response_class=HTMLResponse)
async def apk_download_page():
    if not os.path.isfile(APK_DOWNLOAD_PATH):
        raise HTTPException(status_code=404, detail="APK not available")
    size_mb = os.path.getsize(APK_DOWNLOAD_PATH) / (1024 * 1024)
    return f"""<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MemoPad staging</title>
<div style="font-family:-apple-system,sans-serif;max-width:480px;margin:48px auto;padding:0 20px;text-align:center">
  <h1 style="color:#D84315">MemoPad - staging build</h1>
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
# Served from this backend (same origin as the API) rather than the memopad.app
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


# ---- Database Indexes ----
@app.on_event("startup")
async def create_indexes():
    """Create database indexes for optimal query performance"""
    try:
        # Drop problematic indexes first
        try:
            await db.users.drop_index("email_1")
        except:
            pass

        # Notes indexes
        await db.notes.create_index([("user_id", 1), ("updated_at", -1)])
        await db.notes.create_index([("user_id", 1), ("is_pinned", -1)])
        await db.notes.create_index([("user_id", 1), ("id", 1)])
        await db.notes.create_index([("user_id", 1), ("has_attachments", 1)])
        
        # Events indexes
        await db.events.create_index([("user_id", 1), ("start_time", 1)])
        await db.events.create_index([("user_id", 1), ("id", 1)])
        await db.events.create_index("id")
        # Reminder scheduler: PARTIAL index over only the small pending subset (the vast majority of
        # historical events are 'sent'), so the per-minute tick query stays fast + small.
        await db.events.create_index(
            [("reminder_status", 1), ("reminder_fire_at", 1)],
            partialFilterExpression={"reminder_status": "pending"},
        )

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


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
