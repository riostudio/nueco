from fastapi import FastAPI, APIRouter, UploadFile, File, HTTPException, Query, Depends, Request
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional
import uuid
from datetime import datetime, timezone, timedelta
import tempfile
import bcrypt
import httpx
from pymongo import ReturnDocument
from collections import defaultdict
import time
from openai import AsyncOpenAI

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


def get_openai_client() -> AsyncOpenAI:
    """Create an OpenAI client from environment configuration."""
    api_key = os.getenv("OPENAI_API_KEY") or os.getenv("EMERGENT_LLM_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="OpenAI API key not configured")
    return AsyncOpenAI(api_key=api_key)

def get_client_ip(request: Request) -> str:
    """Get client IP from request, handling proxies"""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"

# Import get_current_user for authentication
from auth.router import get_current_user

# ---- Attachment storage (S3) config ----
import boto3
from botocore.exceptions import ClientError, BotoCoreError

S3_BUCKET = os.getenv("S3_BUCKET")
AWS_REGION = os.getenv("AWS_REGION", "us-east-1")
ATTACHMENT_PREFIX = "note-attachments"
MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024  # 100 MB (videos are large)
ALLOWED_ATTACHMENT_MIME = {
    # images
    "image/jpeg", "image/png", "image/gif", "image/webp", "image/heic",
    # video
    "video/mp4", "video/quicktime", "video/webm", "video/x-msvideo",
    "video/x-matroska", "video/3gpp",
    # audio
    "audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/wav", "audio/x-wav",
    "audio/aac", "audio/ogg", "audio/webm",
    # docs
    "application/pdf", "text/plain", "text/csv",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}
ALLOWED_ATTACHMENT_EXT = {
    "jpg", "jpeg", "png", "gif", "webp", "heic",
    "mp4", "mov", "webm", "avi", "mkv", "3gp", "m4v",
    "mp3", "m4a", "wav", "aac", "ogg", "oga",
    "pdf", "txt", "csv",
    "doc", "docx", "xls", "xlsx", "ppt", "pptx",
}


def get_s3_client():
    """Return a boto3 S3 client, or None if attachment storage isn't configured.
    Credentials come from the standard AWS env vars / IAM role."""
    if not S3_BUCKET:
        return None
    return boto3.client("s3", region_name=AWS_REGION)


# ---- Models ----

class Tag(BaseModel):
    name: str
    color: str

class Attachment(BaseModel):
    id: str
    key: str               # storage object key (server-generated)
    url: str               # download URL
    filename: str
    mime_type: str
    size_bytes: int
    uploaded_at: str

class NoteCreate(BaseModel):
    title: str = ""
    content: str = ""
    tags: List[Tag] = []
    is_pinned: bool = False
    linked_event_id: Optional[str] = None
    images: List[str] = []  # Base64 encoded images
    attachments: List[Attachment] = []
    # E2EE: when set, title/content/tags are client-side ciphertext (AES-256-GCM).
    # None/absent means legacy plaintext (pre-encryption notes, pending migration).
    enc_version: Optional[int] = None

class NoteUpdate(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    tags: Optional[List[Tag]] = None
    is_pinned: Optional[bool] = None
    linked_event_id: Optional[str] = None
    images: Optional[List[str]] = None  # Base64 encoded images
    attachments: Optional[List[Attachment]] = None
    enc_version: Optional[int] = None

class NoteResponse(BaseModel):
    id: str
    title: str
    content: str
    tags: List[Tag]
    is_pinned: bool
    linked_event_id: Optional[str] = None
    images: List[str] = []  # Base64 encoded images
    attachments: List[Attachment] = []
    has_attachments: bool = False
    user_id: Optional[str] = None
    enc_version: Optional[int] = None
    created_at: str
    updated_at: str

class EventCreate(BaseModel):
    title: str
    description: str = ""
    location: str = ""
    start_time: str
    end_time: str
    linked_note_ids: List[str] = []
    reminder_minutes: Optional[int] = None  # Minutes before event to remind
    device_calendar_event_id: Optional[str] = None  # ID from device calendar
    enc_version: Optional[int] = None  # E2EE: when set, title/description/location are client-side ciphertext (AES-256-GCM). None/absent means legacy plaintext.

class EventUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    location: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    linked_note_ids: Optional[List[str]] = None
    reminder_minutes: Optional[int] = None
    device_calendar_event_id: Optional[str] = None
    enc_version: Optional[int] = None

class EventResponse(BaseModel):
    id: str
    title: str
    description: str
    location: str = ""
    start_time: str
    end_time: str
    linked_note_ids: List[str]
    reminder_minutes: Optional[int] = None
    device_calendar_event_id: Optional[str] = None
    user_id: Optional[str] = None
    enc_version: Optional[int] = None
    created_at: str

# Paginated response models
class PaginatedNotesResponse(BaseModel):
    notes: List[NoteResponse]
    total: int
    page: int
    page_size: int
    has_more: bool

class PaginatedEventsResponse(BaseModel):
    events: List[EventResponse]
    total: int
    page: int
    page_size: int
    has_more: bool

# Batch request model for N+1 fix
class BatchEventIds(BaseModel):
    event_ids: List[str]


# ---- Notes Endpoints ----

# Server-side payload caps so an oversized note is rejected cleanly (413) instead
# of consuming memory / risking MongoDB's 16MB document limit as an unhandled 500.
#
# Note fields may arrive as E2EE ciphertext (AES-256-GCM + base64). That inflates a
# plaintext field by ~4/3 (base64) plus a small constant, and further for multibyte
# UTF-8. We size the wire caps with generous headroom over the intended *plaintext*
# limits so encrypted notes aren't falsely rejected, while keeping the stored doc
# comfortably under MongoDB's 16MB ceiling (content ~1MB + images 8MB + title ~4KB).
# Headroom = 5, not 4: a worst-case field is all 3-byte UTF-8 chars (BMP, e.g. CJK),
# which is 3 bytes per UTF-16 unit; AES-GCM adds a 16-byte tag and base64 expands ~4/3,
# so a max-length plaintext field encrypts to just over 4x its char count (measured:
# a 1000-char CJK title -> 4044 ciphertext chars). 4x would 413 those users; 5x clears
# it with margin while keeping the doc well under MongoDB's 16MB ceiling.
_CIPHERTEXT_HEADROOM = 5
MAX_NOTE_TITLE_CHARS = 1_000 * _CIPHERTEXT_HEADROOM            # ~1k plaintext chars
MAX_NOTE_CONTENT_CHARS = 256 * 1024 * _CIPHERTEXT_HEADROOM     # ~256 KB of plaintext text
MAX_NOTE_IMAGES_BYTES = 8 * 1024 * 1024                        # 8 MB total base64 image payload


def _validate_note_payload(title=None, content=None, images=None):
    """Reject oversized note fields with 413. Only checks provided (non-None) fields."""
    if title is not None and len(title) > MAX_NOTE_TITLE_CHARS:
        raise HTTPException(status_code=413, detail=f"Title too long (max {MAX_NOTE_TITLE_CHARS} characters)")
    if content is not None and len(content) > MAX_NOTE_CONTENT_CHARS:
        raise HTTPException(status_code=413, detail=f"Note content too large (max {MAX_NOTE_CONTENT_CHARS // 1024}KB)")
    if images is not None:
        total = sum(len(img) for img in images)
        if total > MAX_NOTE_IMAGES_BYTES:
            raise HTTPException(status_code=413, detail=f"Images too large (max {MAX_NOTE_IMAGES_BYTES // (1024 * 1024)}MB total)")


@api_router.post("/notes", response_model=NoteResponse)
async def create_note(note: NoteCreate, current_user: dict = Depends(get_current_user)):
    _validate_note_payload(note.title, note.content, note.images)
    now = datetime.now(timezone.utc).isoformat()
    user_id = current_user.get("id") or str(current_user.get("_id", ""))
    doc = {
        "id": str(uuid.uuid4()),
        "title": note.title,
        "content": note.content,
        "tags": [t.model_dump() for t in note.tags],
        "is_pinned": note.is_pinned,
        "linked_event_id": note.linked_event_id,
        "images": note.images,
        "attachments": [a.model_dump() for a in note.attachments],
        "has_attachments": len(note.attachments) > 0,
        "user_id": user_id,
        "enc_version": note.enc_version,
        "created_at": now,
        "updated_at": now,
    }
    await db.notes.insert_one(doc)
    doc.pop("_id", None)
    return NoteResponse(**doc)


@api_router.get("/notes", response_model=List[NoteResponse])
async def get_notes(
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(50, ge=1, le=100, description="Items per page"),
    current_user: dict = Depends(get_current_user)
):
    # Note: search is client-side. Once note fields are E2EE ciphertext the server
    # cannot regex-match them, so filtering moved on-device (see index.tsx).
    user_id = current_user.get("id") or str(current_user.get("_id", ""))
    logger.info(f"get_notes called for user_id: {user_id}")
    count_check = await db.notes.count_documents({"user_id": user_id})
    logger.info(f"Total notes found for user: {count_check}")
    query = {"user_id": user_id}

    # Calculate skip for pagination
    skip = (page - 1) * page_size
    
    # Optimized query with field projection and pagination
    notes = await db.notes.find(query, {
        "_id": 0, 
        "id": 1, 
        "title": 1, 
        "content": 1, 
        "tags": 1, 
        "is_pinned": 1, 
        "linked_event_id": 1,
        "images": 1,
        "attachments": 1,
        "has_attachments": 1,
        "user_id": 1,
        "enc_version": 1,
        "created_at": 1,
        "updated_at": 1
    }).sort(
        [("is_pinned", -1), ("updated_at", -1)]
    ).skip(skip).limit(page_size).to_list(page_size)
    
    return [NoteResponse(**n) for n in notes]


@api_router.get("/notes/{note_id}", response_model=NoteResponse)
async def get_note(note_id: str, current_user: dict = Depends(get_current_user)):
    user_id = current_user.get("id") or str(current_user.get("_id", ""))
    note = await db.notes.find_one({"id": note_id, "user_id": user_id}, {"_id": 0})
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    return NoteResponse(**note)


@api_router.put("/notes/{note_id}", response_model=NoteResponse)
async def update_note(note_id: str, update: NoteUpdate, current_user: dict = Depends(get_current_user)):
    _validate_note_payload(update.title, update.content, update.images)
    user_id = current_user.get("id") or str(current_user.get("_id", ""))
    updates = {}
    for k, v in update.model_dump(exclude_unset=True).items():
        if v is None:
            # Only allow explicitly clearing linked_event_id (unlinking an event).
            if k == "linked_event_id":
                updates[k] = None
            continue
        if k == "tags":
            updates[k] = [t if isinstance(t, dict) else t for t in v]
        else:
            updates[k] = v
    # Keep the denormalized flag in sync whenever attachments are part of the update.
    if "attachments" in updates:
        updates["has_attachments"] = len(updates["attachments"]) > 0
    updates["updated_at"] = datetime.now(timezone.utc).isoformat()
    result = await db.notes.update_one({"id": note_id, "user_id": user_id}, {"$set": updates})
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Note not found")
    note = await db.notes.find_one({"id": note_id, "user_id": user_id}, {"_id": 0})
    return NoteResponse(**note)


@api_router.delete("/notes/{note_id}")
async def delete_note(note_id: str, current_user: dict = Depends(get_current_user)):
    user_id = current_user.get("id") or str(current_user.get("_id", ""))
    result = await db.notes.delete_one({"id": note_id, "user_id": user_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Note not found")
    return {"message": "Note deleted"}


@api_router.post("/notes/{note_id}/toggle-pin", response_model=NoteResponse)
async def toggle_pin(note_id: str, current_user: dict = Depends(get_current_user)):
    user_id = current_user.get("id") or str(current_user.get("_id", ""))
    note = await db.notes.find_one({"id": note_id, "user_id": user_id}, {"_id": 0})
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    new_pin = not note.get("is_pinned", False)
    await db.notes.update_one(
        {"id": note_id, "user_id": user_id},
        {"$set": {
            "is_pinned": new_pin,
            "updated_at": datetime.now(timezone.utc).isoformat()
        }}
    )
    note = await db.notes.find_one({"id": note_id, "user_id": user_id}, {"_id": 0})
    return NoteResponse(**note)


# ---- Attachment Endpoints ----

class PresignRequest(BaseModel):
    filename: str
    mime_type: str
    size: int


@api_router.post("/attachments/presign")
async def presign_attachment(req: PresignRequest, current_user: dict = Depends(get_current_user)):
    """Validate a file and return a presigned POST for direct-to-S3 upload.
    The object key is generated server-side under the caller's prefix so a client
    can never write outside its own namespace."""
    s3 = get_s3_client()
    if s3 is None:
        raise HTTPException(status_code=503, detail="File attachments are not enabled on this server")

    user_id = current_user.get("id") or str(current_user.get("_id", ""))

    if req.size <= 0 or req.size > MAX_ATTACHMENT_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"File too large (max {MAX_ATTACHMENT_BYTES // (1024 * 1024)}MB)",
        )

    ext = (req.filename.rsplit(".", 1)[-1] if "." in req.filename else "").lower()
    if ext not in ALLOWED_ATTACHMENT_EXT or req.mime_type not in ALLOWED_ATTACHMENT_MIME:
        raise HTTPException(status_code=400, detail="File type not allowed")

    attachment_id = str(uuid.uuid4())
    key = f"{ATTACHMENT_PREFIX}/{user_id}/{attachment_id}.{ext}"

    try:
        presigned = s3.generate_presigned_post(
            Bucket=S3_BUCKET,
            Key=key,
            Fields={"Content-Type": req.mime_type},
            Conditions=[
                {"Content-Type": req.mime_type},
                ["content-length-range", 1, MAX_ATTACHMENT_BYTES],
            ],
            ExpiresIn=300,
        )
    except (ClientError, BotoCoreError) as e:
        logger.error(f"Failed to presign attachment: {e}")
        raise HTTPException(status_code=502, detail="Could not prepare upload")

    file_url = f"https://{S3_BUCKET}.s3.{AWS_REGION}.amazonaws.com/{key}"
    return {
        "id": attachment_id,
        "key": key,
        "upload_url": presigned["url"],
        "fields": presigned["fields"],
        "file_url": file_url,
    }


@api_router.delete("/attachments")
async def delete_attachment(key: str = Query(...), current_user: dict = Depends(get_current_user)):
    """Delete a stored attachment. Scoped to the caller's own prefix."""
    s3 = get_s3_client()
    if s3 is None:
        raise HTTPException(status_code=503, detail="File attachments are not enabled on this server")

    user_id = current_user.get("id") or str(current_user.get("_id", ""))
    if not key.startswith(f"{ATTACHMENT_PREFIX}/{user_id}/"):
        raise HTTPException(status_code=403, detail="Not allowed to delete this file")

    try:
        s3.delete_object(Bucket=S3_BUCKET, Key=key)
    except (ClientError, BotoCoreError) as e:
        logger.error(f"Failed to delete attachment {key}: {e}")
        raise HTTPException(status_code=502, detail="Could not delete file")
    return {"message": "Attachment deleted"}


class DownloadUrlRequest(BaseModel):
    key: str


@api_router.post("/attachments/download-url")
async def attachment_download_url(req: DownloadUrlRequest, current_user: dict = Depends(get_current_user)):
    """Return a presigned GET URL for viewing/downloading an attachment.
    Scoped to the caller's own prefix. Used for tap-to-open and shareable links."""
    s3 = get_s3_client()
    if s3 is None:
        raise HTTPException(status_code=503, detail="File attachments are not enabled on this server")

    user_id = current_user.get("id") or str(current_user.get("_id", ""))
    if not req.key.startswith(f"{ATTACHMENT_PREFIX}/{user_id}/"):
        raise HTTPException(status_code=403, detail="Not allowed to access this file")

    try:
        url = s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": S3_BUCKET, "Key": req.key},
            ExpiresIn=7 * 24 * 3600,  # 7 days (SigV4 max) - covers tap-to-open and shared links
        )
    except (ClientError, BotoCoreError) as e:
        logger.error(f"Failed to presign download for {req.key}: {e}")
        raise HTTPException(status_code=502, detail="Could not prepare download")
    return {"url": url}


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


# ---- Reminder helpers ----

REMINDER_LABELS = {5: "5 minutes", 15: "15 minutes", 30: "30 minutes", 60: "1 hour", 1440: "1 day"}


def reminder_label(minutes) -> str:
    if not minutes:
        return "a moment"
    return REMINDER_LABELS.get(minutes, f"{minutes} minutes")


def compute_reminder_fields(start_time_iso: Optional[str], reminder_minutes: Optional[int]) -> dict:
    """Derive the scheduler fields for an event. `reminder_fire_at` = start - reminder_minutes.
    Past-due guard: if the fire time is already in the past (or no reminder), mark it 'sent' so a
    backfilled / late-edited event never queues a reminder for something already over."""
    if not reminder_minutes or not start_time_iso:
        return {"reminder_fire_at": None, "reminder_status": "sent", "reminder_claimed_at": None}
    try:
        st = datetime.fromisoformat(start_time_iso.replace("Z", "+00:00"))
        if st.tzinfo is None:
            st = st.replace(tzinfo=timezone.utc)
    except Exception:
        return {"reminder_fire_at": None, "reminder_status": "sent", "reminder_claimed_at": None}
    fire_at = st - timedelta(minutes=reminder_minutes)
    status = "sent" if fire_at <= datetime.now(timezone.utc) else "pending"
    return {"reminder_fire_at": fire_at.isoformat(), "reminder_status": status, "reminder_claimed_at": None}


# Same rationale as _CIPHERTEXT_HEADROOM above: event fields may arrive as E2EE
# ciphertext (Stage 5), so the wire caps carry the same 5x headroom over the intended
# plaintext limits.
MAX_EVENT_TITLE_CHARS = 200 * _CIPHERTEXT_HEADROOM
MAX_EVENT_DESCRIPTION_CHARS = 5_000 * _CIPHERTEXT_HEADROOM
MAX_EVENT_LOCATION_CHARS = 300 * _CIPHERTEXT_HEADROOM


def _validate_event_payload(title=None, description=None, location=None):
    """Reject oversized event fields with 413. Only checks provided (non-None) fields."""
    if title is not None and len(title) > MAX_EVENT_TITLE_CHARS:
        raise HTTPException(status_code=413, detail=f"Title too long (max {MAX_EVENT_TITLE_CHARS} characters)")
    if description is not None and len(description) > MAX_EVENT_DESCRIPTION_CHARS:
        raise HTTPException(status_code=413, detail=f"Description too long (max {MAX_EVENT_DESCRIPTION_CHARS} characters)")
    if location is not None and len(location) > MAX_EVENT_LOCATION_CHARS:
        raise HTTPException(status_code=413, detail=f"Location too long (max {MAX_EVENT_LOCATION_CHARS} characters)")


# ---- Events Endpoints ----

@api_router.post("/events", response_model=EventResponse)
async def create_event(event: EventCreate, current_user: dict = Depends(get_current_user)):
    _validate_event_payload(event.title, event.description, event.location)
    user_id = current_user.get("id") or str(current_user.get("_id", ""))
    doc = {
        "id": str(uuid.uuid4()),
        "title": event.title,
        "description": event.description,
        "location": event.location,
        "start_time": event.start_time,
        "end_time": event.end_time,
        "linked_note_ids": event.linked_note_ids,
        "reminder_minutes": event.reminder_minutes,
        "device_calendar_event_id": event.device_calendar_event_id,
        "user_id": user_id,
        "enc_version": event.enc_version,
        "created_at": datetime.now(timezone.utc).isoformat(),
        **compute_reminder_fields(event.start_time, event.reminder_minutes),
    }
    await db.events.insert_one(doc)
    doc.pop("_id", None)
    return EventResponse(**doc)


@api_router.get("/events", response_model=List[EventResponse])
async def get_events(
    month: Optional[int] = Query(None),
    year: Optional[int] = Query(None),
    current_user: dict = Depends(get_current_user),
):
    user_id = current_user.get("id") or str(current_user.get("_id", ""))
    query = {"user_id": user_id}
    if month is not None and year is not None:
        start = f"{year:04d}-{month:02d}-01"
        if month == 12:
            end = f"{year + 1:04d}-01-01"
        else:
            end = f"{year:04d}-{month + 1:02d}-01"
        query = {"user_id": user_id, "start_time": {"$gte": start, "$lt": end}}
    # Optimized query with field projection
    events = await db.events.find(query, {
        "_id": 0,
        "id": 1,
        "title": 1,
        "description": 1,
        "location": 1,
        "start_time": 1,
        "end_time": 1,
        "linked_note_ids": 1,
        "reminder_minutes": 1,
        "device_calendar_event_id": 1,
        "user_id": 1,
        "enc_version": 1,
        "created_at": 1
    }).sort("start_time", 1).to_list(100)  # Reduced limit
    return [EventResponse(**e) for e in events]


@api_router.get("/events/{event_id}", response_model=EventResponse)
async def get_event(event_id: str, current_user: dict = Depends(get_current_user)):
    user_id = current_user.get("id") or str(current_user.get("_id", ""))
    event = await db.events.find_one({"id": event_id, "user_id": user_id}, {"_id": 0})
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    return EventResponse(**event)


# Batch endpoint to fix N+1 query issue
@api_router.post("/events/batch", response_model=List[EventResponse])
async def get_events_batch(
    batch_request: BatchEventIds,
    current_user: dict = Depends(get_current_user)
):
    """Fetch multiple events by IDs in a single request (fixes N+1 query)"""
    user_id = current_user.get("id") or str(current_user.get("_id", ""))
    
    if not batch_request.event_ids:
        return []
    
    # Limit batch size to prevent abuse
    event_ids = batch_request.event_ids[:50]
    
    events = await db.events.find(
        {"id": {"$in": event_ids}, "user_id": user_id},
        {"_id": 0}
    ).to_list(50)
    
    return [EventResponse(**e) for e in events]


@api_router.put("/events/{event_id}", response_model=EventResponse)
async def update_event(event_id: str, update: EventUpdate, current_user: dict = Depends(get_current_user)):
    _validate_event_payload(update.title, update.description, update.location)
    user_id = current_user.get("id") or str(current_user.get("_id", ""))
    existing = await db.events.find_one({"id": event_id, "user_id": user_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Event not found")
    updates = {}
    for k, v in update.model_dump(exclude_unset=True).items():
        if v is not None:
            updates[k] = v
    # Recompute the reminder scheduler fields when the timing changed. Only reset the send state
    # when the fire time actually moves (so unrelated edits don't re-fire an already-sent reminder).
    if "start_time" in updates or "reminder_minutes" in updates:
        new_start = updates.get("start_time", existing.get("start_time"))
        new_minutes = updates.get("reminder_minutes", existing.get("reminder_minutes"))
        fields = compute_reminder_fields(new_start, new_minutes)
        if fields["reminder_fire_at"] != existing.get("reminder_fire_at"):
            updates.update(fields)
    await db.events.update_one({"id": event_id, "user_id": user_id}, {"$set": updates})
    event = await db.events.find_one({"id": event_id, "user_id": user_id}, {"_id": 0})
    return EventResponse(**event)


@api_router.delete("/events/{event_id}")
async def delete_event(event_id: str, current_user: dict = Depends(get_current_user)):
    user_id = current_user.get("id") or str(current_user.get("_id", ""))
    result = await db.events.delete_one({"id": event_id, "user_id": user_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Event not found")
    return {"message": "Event deleted"}


# ---- Account deletion (GDPR right to erasure) ----

class DeleteAccountRequest(BaseModel):
    password: str


def _delete_user_s3_attachments(user_id: str):
    """Best-effort deletion of every stored attachment under the user's prefix."""
    s3 = get_s3_client()
    if not s3:
        return
    try:
        prefix = f"{ATTACHMENT_PREFIX}/{user_id}/"
        paginator = s3.get_paginator("list_objects_v2")
        batch = []
        for page in paginator.paginate(Bucket=S3_BUCKET, Prefix=prefix):
            for obj in page.get("Contents", []):
                batch.append({"Key": obj["Key"]})
                if len(batch) == 1000:
                    s3.delete_objects(Bucket=S3_BUCKET, Delete={"Objects": batch})
                    batch = []
        if batch:
            s3.delete_objects(Bucket=S3_BUCKET, Delete={"Objects": batch})
    except Exception as e:
        logger.error(f"S3 attachment cleanup failed for user {user_id}: {e}")


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
    _delete_user_s3_attachments(user_id)
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
    handles per-item results, and records tickets for later receipt resolution."""
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


# ---- Transcription Endpoint ----

class TranscribeBase64Request(BaseModel):
    audio_base64: str
    file_extension: str = "m4a"

@api_router.post("/transcribe-base64")
async def transcribe_audio_base64(request: TranscribeBase64Request, current_user: dict = Depends(get_current_user)):
    """Transcribe audio from base64 encoded data (requires authentication)"""
    try:
        import base64

        logger.info(f"Received base64 transcription request. Extension: {request.file_extension}, Base64 length: {len(request.audio_base64)}")
        client = get_openai_client()
        
        # Decode base64 to bytes
        try:
            audio_bytes = base64.b64decode(request.audio_base64)
            logger.info(f"Decoded {len(audio_bytes)} bytes from base64")
        except Exception as e:
            logger.error(f"Failed to decode base64: {e}")
            raise HTTPException(status_code=400, detail="Invalid base64 audio data")
        
        # Determine file extension
        extension = request.file_extension.lower()
        if not extension.startswith('.'):
            extension = f'.{extension}'
        
        # Map unsupported formats
        if extension == '.caf':
            extension = '.m4a'
        
        logger.info(f"Processing audio with extension: {extension}")

        with tempfile.NamedTemporaryFile(delete=False, suffix=extension) as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name

        try:
            with open(tmp_path, "rb") as audio_file:
                response = await client.audio.transcriptions.create(
                    model="whisper-1",
                    file=audio_file,
                    # language removed - Whisper auto-detects
                )
            transcription_text = response.text or ""
            logger.info(f"Transcription successful: {transcription_text[:100] if transcription_text else 'empty'}...")
            return {"text": transcription_text}
        finally:
            os.unlink(tmp_path)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Transcription error: {e}")
        raise HTTPException(
            status_code=500, detail=f"Transcription failed: {str(e)}"
        )

@api_router.post("/transcribe")
async def transcribe_audio(file: UploadFile = File(...), current_user: dict = Depends(get_current_user)):
    """Transcribe uploaded audio file (requires authentication)"""
    try:
        logger.info(f"Received transcription request. Filename: {file.filename}, Content-Type: {file.content_type}")
        client = get_openai_client()
        
        # Get extension from filename or default to m4a
        original_filename = file.filename or "recording.m4a"
        suffix = os.path.splitext(original_filename)[1] or ".m4a"
        
        # Map common audio extensions to supported formats
        if suffix.lower() == '.caf':
            suffix = '.m4a'  # Convert CAF to m4a for Whisper compatibility
        
        logger.info(f"Processing audio file with suffix: {suffix}")

        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            content = await file.read()
            logger.info(f"Read {len(content)} bytes from uploaded file")
            tmp.write(content)
            tmp_path = tmp.name

        try:
            with open(tmp_path, "rb") as audio_file:
                response = await client.audio.transcriptions.create(
                    model="whisper-1",
                    file=audio_file,
                    # language removed - Whisper auto-detects
                )
            transcription_text = response.text or ""
            logger.info(f"Transcription successful: {transcription_text[:100]}...")
            return {"text": transcription_text}
        finally:
            os.unlink(tmp_path)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Transcription error: {e}")
        raise HTTPException(
            status_code=500, detail=f"Transcription failed: {str(e)}"
        )


# ---- Text Processing Endpoint (Organize/Summarize) ----

class TextProcessRequest(BaseModel):
    text: str
    action: str  # "organize" or "summarize"

@api_router.post("/process-text")
async def process_text(request: TextProcessRequest, current_user: dict = Depends(get_current_user)):
    """Process text using AI - organize or summarize (requires authentication)"""
    try:
        client = get_openai_client()
        
        if request.action == "organize":
            system_message = "You are a helpful assistant that organizes and structures text to make it easier to read."
            prompt = f"""Please organize and structure the following text to make it easier to read. 
Add appropriate formatting like:
- Clear paragraphs
- Bullet points where appropriate
- Headers if needed
- Fix any grammar or punctuation issues

Keep the original meaning intact. Here's the text:

{request.text}

Return only the organized text, no explanations."""
        
        elif request.action == "summarize":
            system_message = "You are a helpful assistant that summarizes text concisely while keeping key points."
            prompt = f"""Please summarize the following text concisely while keeping the key points.
Make it clear and easy to read.

Here's the text:

{request.text}

Return only the summary, no explanations."""
        
        else:
            raise HTTPException(status_code=400, detail="Invalid action. Use 'organize' or 'summarize'")
        
        logger.info(f"Processing text with action: {request.action}, text length: {len(request.text)}")

        response = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": system_message},
                {"role": "user", "content": prompt},
            ],
            temperature=0.2,
        )
        processed_text = (response.choices[0].message.content or "").strip()
        if not processed_text:
            raise HTTPException(status_code=500, detail="AI service returned an empty response")
        logger.info(f"Text processing successful, result length: {len(processed_text)}")
        
        return {"text": processed_text}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Text processing error: {e}")
        raise HTTPException(
            status_code=500, detail=f"Text processing failed: {str(e)}"
        )


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

app.include_router(api_router)


# ---- Staging APK download ----
# Serve the built APK from this backend so the download link and the /api the app
# talks to share one origin/port (e.g. http://192.168.20.32:8765). The path is
# configurable via APK_DOWNLOAD_PATH; if the file is absent (e.g. on Railway) the
# routes 404, so this is harmless in deployments that don't ship the APK.
from fastapi.responses import FileResponse, HTMLResponse

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


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
