from fastapi import FastAPI, APIRouter, UploadFile, File, HTTPException, Query
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional
import uuid
from datetime import datetime, timezone
import tempfile

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


# ---- Models ----

class Tag(BaseModel):
    name: str
    color: str

class NoteCreate(BaseModel):
    title: str = ""
    content: str = ""
    tags: List[Tag] = []
    is_pinned: bool = False
    linked_event_id: Optional[str] = None

class NoteUpdate(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    tags: Optional[List[Tag]] = None
    is_pinned: Optional[bool] = None
    linked_event_id: Optional[str] = None

class NoteResponse(BaseModel):
    id: str
    title: str
    content: str
    tags: List[Tag]
    is_pinned: bool
    linked_event_id: Optional[str] = None
    created_at: str
    updated_at: str

class EventCreate(BaseModel):
    title: str
    description: str = ""
    start_time: str
    end_time: str
    linked_note_ids: List[str] = []

class EventUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    linked_note_ids: Optional[List[str]] = None

class EventResponse(BaseModel):
    id: str
    title: str
    description: str
    start_time: str
    end_time: str
    linked_note_ids: List[str]
    created_at: str


# ---- Notes Endpoints ----

@api_router.post("/notes", response_model=NoteResponse)
async def create_note(note: NoteCreate):
    now = datetime.now(timezone.utc).isoformat()
    doc = {
        "id": str(uuid.uuid4()),
        "title": note.title,
        "content": note.content,
        "tags": [t.model_dump() for t in note.tags],
        "is_pinned": note.is_pinned,
        "linked_event_id": note.linked_event_id,
        "created_at": now,
        "updated_at": now,
    }
    await db.notes.insert_one(doc)
    doc.pop("_id", None)
    return NoteResponse(**doc)


@api_router.get("/notes", response_model=List[NoteResponse])
async def get_notes(search: Optional[str] = Query(None)):
    query = {}
    if search:
        query = {
            "$or": [
                {"title": {"$regex": search, "$options": "i"}},
                {"content": {"$regex": search, "$options": "i"}},
                {"tags.name": {"$regex": search, "$options": "i"}},
            ]
        }
    notes = await db.notes.find(query, {"_id": 0}).sort(
        [("is_pinned", -1), ("updated_at", -1)]
    ).to_list(1000)
    return [NoteResponse(**n) for n in notes]


@api_router.get("/notes/{note_id}", response_model=NoteResponse)
async def get_note(note_id: str):
    note = await db.notes.find_one({"id": note_id}, {"_id": 0})
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    return NoteResponse(**note)


@api_router.put("/notes/{note_id}", response_model=NoteResponse)
async def update_note(note_id: str, update: NoteUpdate):
    updates = {}
    for k, v in update.model_dump(exclude_unset=True).items():
        if v is not None:
            if k == "tags":
                updates[k] = [t if isinstance(t, dict) else t for t in v]
            else:
                updates[k] = v
    updates["updated_at"] = datetime.now(timezone.utc).isoformat()
    result = await db.notes.update_one({"id": note_id}, {"$set": updates})
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Note not found")
    note = await db.notes.find_one({"id": note_id}, {"_id": 0})
    return NoteResponse(**note)


@api_router.delete("/notes/{note_id}")
async def delete_note(note_id: str):
    result = await db.notes.delete_one({"id": note_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Note not found")
    return {"message": "Note deleted"}


@api_router.post("/notes/{note_id}/toggle-pin", response_model=NoteResponse)
async def toggle_pin(note_id: str):
    note = await db.notes.find_one({"id": note_id}, {"_id": 0})
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    new_pin = not note.get("is_pinned", False)
    await db.notes.update_one(
        {"id": note_id},
        {"$set": {
            "is_pinned": new_pin,
            "updated_at": datetime.now(timezone.utc).isoformat()
        }}
    )
    note = await db.notes.find_one({"id": note_id}, {"_id": 0})
    return NoteResponse(**note)


# ---- Events Endpoints ----

@api_router.post("/events", response_model=EventResponse)
async def create_event(event: EventCreate):
    doc = {
        "id": str(uuid.uuid4()),
        "title": event.title,
        "description": event.description,
        "start_time": event.start_time,
        "end_time": event.end_time,
        "linked_note_ids": event.linked_note_ids,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.events.insert_one(doc)
    doc.pop("_id", None)
    return EventResponse(**doc)


@api_router.get("/events", response_model=List[EventResponse])
async def get_events(
    month: Optional[int] = Query(None),
    year: Optional[int] = Query(None),
):
    query = {}
    if month is not None and year is not None:
        start = f"{year:04d}-{month:02d}-01"
        if month == 12:
            end = f"{year + 1:04d}-01-01"
        else:
            end = f"{year:04d}-{month + 1:02d}-01"
        query = {"start_time": {"$gte": start, "$lt": end}}
    events = await db.events.find(query, {"_id": 0}).sort("start_time", 1).to_list(1000)
    return [EventResponse(**e) for e in events]


@api_router.get("/events/{event_id}", response_model=EventResponse)
async def get_event(event_id: str):
    event = await db.events.find_one({"id": event_id}, {"_id": 0})
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    return EventResponse(**event)


@api_router.put("/events/{event_id}", response_model=EventResponse)
async def update_event(event_id: str, update: EventUpdate):
    updates = {}
    for k, v in update.model_dump(exclude_unset=True).items():
        if v is not None:
            updates[k] = v
    result = await db.events.update_one({"id": event_id}, {"$set": updates})
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Event not found")
    event = await db.events.find_one({"id": event_id}, {"_id": 0})
    return EventResponse(**event)


@api_router.delete("/events/{event_id}")
async def delete_event(event_id: str):
    result = await db.events.delete_one({"id": event_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Event not found")
    return {"message": "Event deleted"}


# ---- Transcription Endpoint ----

@api_router.post("/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    try:
        from emergentintegrations.llm.openai import OpenAISpeechToText

        api_key = os.getenv("EMERGENT_LLM_KEY")
        if not api_key:
            raise HTTPException(
                status_code=500, detail="Transcription service not configured"
            )

        stt = OpenAISpeechToText(api_key=api_key)
        suffix = os.path.splitext(file.filename or "audio.m4a")[1] or ".m4a"

        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            content = await file.read()
            tmp.write(content)
            tmp_path = tmp.name

        try:
            with open(tmp_path, "rb") as audio_file:
                response = await stt.transcribe(
                    file=audio_file,
                    model="whisper-1",
                    response_format="json",
                    language="en",
                )
            return {"text": response.text}
        finally:
            os.unlink(tmp_path)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Transcription error: {e}")
        raise HTTPException(
            status_code=500, detail=f"Transcription failed: {str(e)}"
        )


# ---- Health Check ----

@api_router.get("/health")
async def health_check():
    return {"status": "healthy", "timestamp": datetime.now(timezone.utc).isoformat()}


# Include auth router
from auth.router import router as auth_router
api_router.include_router(auth_router)

app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
