from fastapi import FastAPI, APIRouter, UploadFile, File, HTTPException, Query, Depends, Request
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import re
import logging
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional
import uuid
from datetime import datetime, timezone
import tempfile
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

class NoteUpdate(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    tags: Optional[List[Tag]] = None
    is_pinned: Optional[bool] = None
    linked_event_id: Optional[str] = None
    images: Optional[List[str]] = None  # Base64 encoded images
    attachments: Optional[List[Attachment]] = None

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
    created_at: str
    updated_at: str

class EventCreate(BaseModel):
    title: str
    description: str = ""
    start_time: str
    end_time: str
    linked_note_ids: List[str] = []
    reminder_minutes: Optional[int] = None  # Minutes before event to remind
    device_calendar_event_id: Optional[str] = None  # ID from device calendar

class EventUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    linked_note_ids: Optional[List[str]] = None
    reminder_minutes: Optional[int] = None
    device_calendar_event_id: Optional[str] = None

class EventResponse(BaseModel):
    id: str
    title: str
    description: str
    start_time: str
    end_time: str
    linked_note_ids: List[str]
    reminder_minutes: Optional[int] = None
    device_calendar_event_id: Optional[str] = None
    user_id: Optional[str] = None
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

@api_router.post("/notes", response_model=NoteResponse)
async def create_note(note: NoteCreate, current_user: dict = Depends(get_current_user)):
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
        "created_at": now,
        "updated_at": now,
    }
    await db.notes.insert_one(doc)
    doc.pop("_id", None)
    return NoteResponse(**doc)


@api_router.get("/notes", response_model=List[NoteResponse])
async def get_notes(
    search: Optional[str] = Query(None),
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(50, ge=1, le=100, description="Items per page"),
    current_user: dict = Depends(get_current_user)
):
    user_id = current_user.get("id") or str(current_user.get("_id", ""))
    logger.info(f"get_notes called for user_id: {user_id}")
    count_check = await db.notes.count_documents({"user_id": user_id})
    logger.info(f"Total notes found for user: {count_check}")
    query = {"user_id": user_id}
    if search:
        escaped_search = re.escape(search)
        query = {
            "$and": [
                {"user_id": user_id},
                {"$or": [
                    {"title": {"$regex": escaped_search, "$options": "i"}},
                    {"content": {"$regex": escaped_search, "$options": "i"}},
                    {"tags.name": {"$regex": escaped_search, "$options": "i"}},
                ]}
            ]
        }
    
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
            ExpiresIn=7 * 24 * 3600,  # 7 days (SigV4 max) — covers tap-to-open and shared links
        )
    except (ClientError, BotoCoreError) as e:
        logger.error(f"Failed to presign download for {req.key}: {e}")
        raise HTTPException(status_code=502, detail="Could not prepare download")
    return {"url": url}


# ---- Events Endpoints ----

@api_router.post("/events", response_model=EventResponse)
async def create_event(event: EventCreate, current_user: dict = Depends(get_current_user)):
    user_id = current_user.get("id") or str(current_user.get("_id", ""))
    doc = {
        "id": str(uuid.uuid4()),
        "title": event.title,
        "description": event.description,
        "start_time": event.start_time,
        "end_time": event.end_time,
        "linked_note_ids": event.linked_note_ids,
        "reminder_minutes": event.reminder_minutes,
        "device_calendar_event_id": event.device_calendar_event_id,
        "user_id": user_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
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
        "start_time": 1, 
        "end_time": 1, 
        "linked_note_ids": 1, 
        "reminder_minutes": 1, 
        "device_calendar_event_id": 1, 
        "user_id": 1,
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
    user_id = current_user.get("id") or str(current_user.get("_id", ""))
    updates = {}
    for k, v in update.model_dump(exclude_unset=True).items():
        if v is not None:
            updates[k] = v
    result = await db.events.update_one({"id": event_id, "user_id": user_id}, {"$set": updates})
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Event not found")
    event = await db.events.find_one({"id": event_id, "user_id": user_id}, {"_id": 0})
    return EventResponse(**event)


@api_router.delete("/events/{event_id}")
async def delete_event(event_id: str, current_user: dict = Depends(get_current_user)):
    user_id = current_user.get("id") or str(current_user.get("_id", ""))
    result = await db.events.delete_one({"id": event_id, "user_id": user_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Event not found")
    return {"message": "Event deleted"}


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
        
        # Users indexes
        await db.users.create_index("email", unique=True, sparse=True)
        await db.users.create_index("id", unique=True, sparse=True)
        
        # Sessions indexes with TTL
        await db.sessions.create_index("expires_at", expireAfterSeconds=0)
        await db.sessions.create_index("user_id")
        
        # Devices indexes
        await db.devices.create_index("user_id")
        
        logger.info("Database indexes created successfully")
    except Exception as e:
        logger.warning(f"Could not create indexes (may already exist): {e}")


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
