"""
Shared test bootstrap for the MemoPad simulation suite.

SAFETY MODEL (local-isolated mode):
  - The real FastAPI app (backend/server.py) is imported and exercised in-process.
  - motor's AsyncIOMotorClient is monkeypatched to an in-memory mongomock client
    BEFORE server import, so NO connection is ever made to MongoDB Atlas.
  - openai / boto3 / botocore are replaced with no-op stubs (those code paths are
    never exercised here) to avoid heavy installs and any outbound calls.
  - All HTTP goes through httpx ASGITransport (in-process) -- no network sockets,
    no Railway. MEMOPAD_API_URL / Railway are untouched.

Because the datastore is in-memory, latency numbers are NOT representative of the
Railway deployment. This mode validates correctness/logic: data integrity,
retrieval accuracy, user isolation, input handling, validation, and auth security.
"""
import os
import sys
import types
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = REPO_ROOT / "backend"

# --- 1. Isolated environment (never the real .env values) -------------------
os.environ["MONGO_URL"] = "mongodb://127.0.0.1:27017"      # never dialed (mock)
os.environ["DB_NAME"] = "memopad_test"                      # isolated logical db
os.environ["JWT_SECRET"] = "test-only-secret-not-production-do-not-reuse"
os.environ["APP_BASE_URL"] = "http://localhost/app"
os.environ["ALLOWED_ORIGINS"] = "http://localhost,https://memopad.test"
os.environ.pop("S3_BUCKET", None)                           # attachments -> 503 path
os.environ.setdefault("OPENAI_API_KEY", "")                # AI paths stubbed anyway

# CRITICAL: server.py runs load_dotenv(backend/.env) at import, which would pull
# the REAL Resend key / AWS creds into the environment and trigger outbound email.
# load_dotenv uses override=False, so pre-seeding these (empty) here keeps the real
# secrets from ever loading and forces the app's own dev no-op paths.
for _secret in ("SMTP_PASS", "SMTP_FROM", "EMERGENT_LLM_KEY",
                "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"):
    os.environ[_secret] = ""


# --- 2. Stub heavy / outbound-only third-party modules ----------------------
def _install_stub_modules() -> None:
    # openai.AsyncOpenAI
    if "openai" not in sys.modules:
        openai_mod = types.ModuleType("openai")

        class _StubAsyncOpenAI:  # pragma: no cover - never called in these tests
            def __init__(self, *a, **k):
                raise RuntimeError("openai stub: AI endpoints are not exercised in local-isolated mode")

        openai_mod.AsyncOpenAI = _StubAsyncOpenAI
        sys.modules["openai"] = openai_mod

    # boto3
    if "boto3" not in sys.modules:
        boto3_mod = types.ModuleType("boto3")

        def _client(*a, **k):  # pragma: no cover
            raise RuntimeError("boto3 stub: S3 not configured in local-isolated mode")

        boto3_mod.client = _client
        sys.modules["boto3"] = boto3_mod

    # requests: hard network backstop. Backend code (email_service) only uses it
    # for outbound email; in isolated mode that must never leave the process.
    if "requests" not in sys.modules:
        requests_mod = types.ModuleType("requests")

        def _blocked(*a, **k):  # pragma: no cover
            raise RuntimeError("requests stub: outbound HTTP is blocked in local-isolated mode")

        requests_mod.post = _blocked
        requests_mod.get = _blocked
        requests_mod.put = _blocked
        requests_mod.delete = _blocked
        requests_mod.request = _blocked
        sys.modules["requests"] = requests_mod

    # botocore.exceptions
    if "botocore" not in sys.modules:
        botocore_mod = types.ModuleType("botocore")
        exc_mod = types.ModuleType("botocore.exceptions")

        class ClientError(Exception):
            pass

        class BotoCoreError(Exception):
            pass

        exc_mod.ClientError = ClientError
        exc_mod.BotoCoreError = BotoCoreError
        botocore_mod.exceptions = exc_mod
        sys.modules["botocore"] = botocore_mod
        sys.modules["botocore.exceptions"] = exc_mod


def _patch_motor_with_mongomock() -> None:
    """Replace motor's async client with the in-memory mongomock implementation."""
    import motor.motor_asyncio as motor_asyncio
    from mongomock_motor import AsyncMongoMockClient

    motor_asyncio.AsyncIOMotorClient = AsyncMongoMockClient


_app = None
_server = None


def boot():
    """Import (once) and return (app, server_module). Idempotent."""
    global _app, _server
    if _app is not None:
        return _app, _server

    _install_stub_modules()
    _patch_motor_with_mongomock()

    if str(BACKEND_DIR) not in sys.path:
        sys.path.insert(0, str(BACKEND_DIR))

    import server  # noqa: E402  (real backend app, now wired to mongomock)

    _server = server
    _app = server.app
    return _app, _server


def make_client(forwarded_for: str | None = None):
    """Return an httpx.AsyncClient bound to the in-process ASGI app.

    forwarded_for sets X-Forwarded-For so each synthetic user gets a distinct
    client IP (the app honours that header), dodging per-IP rate limits the way
    20 real devices behind separate networks would.
    """
    import httpx

    app, _ = boot()
    headers = {}
    if forwarded_for:
        headers["X-Forwarded-For"] = forwarded_for
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
        headers=headers,
        timeout=30.0,
    )


async def reset_db():
    """Drop all collections in the isolated test db (idempotent re-runs)."""
    _, server = boot()
    for coll in ("notes", "events", "users", "sessions", "devices"):
        await server.db[coll].delete_many({})


async def verify_user_email(email: str):
    """Simulate the user clicking the email-verification link by flipping the
    flag directly in the isolated DB (we cannot receive real email in tests)."""
    _, server = boot()
    await server.db.users.update_one(
        {"email": email.lower()},
        {"$set": {"email_verified": True},
         "$unset": {"verification_token": "", "verification_token_expiry": ""}},
    )


async def count_user_notes(user_id: str) -> int:
    _, server = boot()
    return await server.db.notes.count_documents({"user_id": user_id})


def mint_token(sub: str, *, expired: bool = False, wrong_type: bool = False,
               wrong_secret: bool = False) -> str:
    """Mint a JWT the way the server would, for negative auth tests."""
    import jwt
    from datetime import datetime, timedelta
    exp = datetime.utcnow() + (timedelta(minutes=-5) if expired else timedelta(minutes=60))
    payload = {"sub": sub, "type": ("refresh" if wrong_type else "access"), "exp": exp}
    secret = "totally-different-secret" if wrong_secret else os.environ["JWT_SECRET"]
    return jwt.encode(payload, secret, algorithm="HS256")
