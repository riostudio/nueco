from typing import List, Optional
from pydantic import BaseModel

from attachments.schemas import Attachment


class Tag(BaseModel):
    name: str
    color: str


class NoteCreate(BaseModel):
    title: str = ""
    content: str = ""
    tags: List[Tag] = []
    is_pinned: bool = False
    linked_event_id: Optional[str] = None  # Deprecated: use linked_event_ids. Kept for old clients.
    linked_event_ids: List[str] = []
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
    linked_event_id: Optional[str] = None  # Deprecated: use linked_event_ids. Kept for old clients.
    linked_event_ids: Optional[List[str]] = None
    images: Optional[List[str]] = None  # Base64 encoded images
    attachments: Optional[List[Attachment]] = None
    enc_version: Optional[int] = None


class NoteResponse(BaseModel):
    id: str
    title: str
    content: str
    tags: List[Tag]
    is_pinned: bool
    linked_event_id: Optional[str] = None  # Deprecated: use linked_event_ids. Kept for old clients.
    linked_event_ids: List[str] = []
    images: List[str] = []  # Base64 encoded images
    attachments: List[Attachment] = []
    has_attachments: bool = False
    user_id: Optional[str] = None
    enc_version: Optional[int] = None
    created_at: str
    updated_at: str


class PaginatedNotesResponse(BaseModel):
    notes: List[NoteResponse]
    total: int
    page: int
    page_size: int
    has_more: bool
