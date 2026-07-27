"""Business logic for notes: payload size validation, persistence, and the deprecated
linked_event_id/linked_event_ids dual-read/dual-write shim.

Framework-agnostic: raises plain exceptions (NoteNotFoundError, NotePayloadTooLargeError)
rather than fastapi.HTTPException. backend/notes/router.py translates them to HTTP responses.
"""
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from motor.motor_asyncio import AsyncIOMotorDatabase

from .schemas import NoteCreate, NoteUpdate


class NoteNotFoundError(Exception):
    pass


class NotePayloadTooLargeError(Exception):
    pass


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
    """Reject oversized note fields. Only checks provided (non-None) fields."""
    if title is not None and len(title) > MAX_NOTE_TITLE_CHARS:
        raise NotePayloadTooLargeError(f"Title too long (max {MAX_NOTE_TITLE_CHARS} characters)")
    if content is not None and len(content) > MAX_NOTE_CONTENT_CHARS:
        raise NotePayloadTooLargeError(f"Note content too large (max {MAX_NOTE_CONTENT_CHARS // 1024}KB)")
    if images is not None:
        total = sum(len(img) for img in images)
        if total > MAX_NOTE_IMAGES_BYTES:
            raise NotePayloadTooLargeError(f"Images too large (max {MAX_NOTE_IMAGES_BYTES // (1024 * 1024)}MB total)")


def _normalize_linked_event_ids(doc: dict) -> dict:
    """Dual read-side normalizer: a Note can now link multiple events (`linked_event_ids`),
    but old rows (and old app builds still writing only the singular field) only have
    `linked_event_id`. Fill `linked_event_ids` from the legacy field when absent/empty so
    every NoteResponse presents a consistent array, with no Mongo migration required."""
    ids = doc.get("linked_event_ids")
    if not ids and doc.get("linked_event_id"):
        ids = [doc["linked_event_id"]]
    doc["linked_event_ids"] = ids or []
    return doc


class NotesService:
    def __init__(self, db: AsyncIOMotorDatabase):
        self.db = db

    async def create(self, user_id: str, note: NoteCreate) -> dict:
        _validate_note_payload(note.title, note.content, note.images)
        now = datetime.now(timezone.utc).isoformat()
        # linked_event_ids (new, plural) is authoritative when provided; dual-write
        # linked_event_id (deprecated, singular) so an old app build reading only the
        # legacy field still sees a link rather than it silently vanishing.
        linked_event_ids = note.linked_event_ids or ([note.linked_event_id] if note.linked_event_id else [])
        doc = {
            "id": str(uuid.uuid4()),
            "title": note.title,
            "content": note.content,
            "tags": [t.model_dump() for t in note.tags],
            "is_pinned": note.is_pinned,
            "linked_event_id": linked_event_ids[0] if linked_event_ids else None,
            "linked_event_ids": linked_event_ids,
            "images": note.images,
            "attachments": [a.model_dump() for a in note.attachments],
            "has_attachments": len(note.attachments) > 0,
            "user_id": user_id,
            "enc_version": note.enc_version,
            "created_at": now,
            "updated_at": now,
        }
        await self.db.notes.insert_one(doc)
        doc.pop("_id", None)
        return doc

    async def list(self, user_id: str, page: int, page_size: int) -> List[dict]:
        # Note: search is client-side. Once note fields are E2EE ciphertext the server
        # cannot regex-match them, so filtering moved on-device (see index.tsx).
        query = {"user_id": user_id}
        skip = (page - 1) * page_size
        notes = await self.db.notes.find(query, {
            "_id": 0,
            "id": 1,
            "title": 1,
            "content": 1,
            "tags": 1,
            "is_pinned": 1,
            "linked_event_id": 1,
            "linked_event_ids": 1,
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
        return [_normalize_linked_event_ids(n) for n in notes]

    async def get(self, user_id: str, note_id: str) -> dict:
        note = await self.db.notes.find_one({"id": note_id, "user_id": user_id}, {"_id": 0})
        if not note:
            raise NoteNotFoundError()
        return _normalize_linked_event_ids(note)

    async def update(self, user_id: str, note_id: str, update: NoteUpdate) -> dict:
        _validate_note_payload(update.title, update.content, update.images)
        updates = {}
        for k, v in update.model_dump(exclude_unset=True).items():
            if v is None:
                # Only allow explicitly clearing linked_event_id/linked_event_ids (unlinking).
                if k == "linked_event_id":
                    updates[k] = None
                elif k == "linked_event_ids":
                    updates[k] = []
                    updates["linked_event_id"] = None
                continue
            if k == "tags":
                updates[k] = [t if isinstance(t, dict) else t for t in v]
            elif k == "linked_event_ids":
                updates[k] = v
                # Dual-write the deprecated singular field so an old app build still reading
                # only linked_event_id doesn't see a link silently vanish.
                updates["linked_event_id"] = v[0] if v else None
            else:
                updates[k] = v
        # Keep the denormalized flag in sync whenever attachments are part of the update.
        if "attachments" in updates:
            updates["has_attachments"] = len(updates["attachments"]) > 0
        updates["updated_at"] = datetime.now(timezone.utc).isoformat()
        result = await self.db.notes.update_one({"id": note_id, "user_id": user_id}, {"$set": updates})
        if result.matched_count == 0:
            raise NoteNotFoundError()
        note = await self.db.notes.find_one({"id": note_id, "user_id": user_id}, {"_id": 0})
        return _normalize_linked_event_ids(note)

    async def delete(self, user_id: str, note_id: str) -> None:
        result = await self.db.notes.delete_one({"id": note_id, "user_id": user_id})
        if result.deleted_count == 0:
            raise NoteNotFoundError()

    async def toggle_pin(self, user_id: str, note_id: str) -> dict:
        note = await self.db.notes.find_one({"id": note_id, "user_id": user_id}, {"_id": 0})
        if not note:
            raise NoteNotFoundError()
        new_pin = not note.get("is_pinned", False)
        await self.db.notes.update_one(
            {"id": note_id, "user_id": user_id},
            {"$set": {
                "is_pinned": new_pin,
                "updated_at": datetime.now(timezone.utc).isoformat()
            }}
        )
        return await self.db.notes.find_one({"id": note_id, "user_id": user_id}, {"_id": 0})
