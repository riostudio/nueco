from typing import List, Optional
from pydantic import BaseModel

from attachments.schemas import Attachment


class Tag(BaseModel):
    name: str
    color: str


class ImageObject(BaseModel):
    """A free-floating, drag/pinch/rotate-able image layered over the note's text - distinct
    from the plain `images` gallery (base64 thumbnails, no transforms) and from `attachments`
    (arbitrary files). See ImageObject in frontend/src/types.ts for the mirrored shape."""
    id: str
    type: str = "image"  # only "image" for now; kept as a string tag for future object types
    local_uri: Optional[str] = None
    remote_url: Optional[str] = None  # informational only - the bucket is private, never fetched
    # directly from this URL; real display access goes through POST /attachments/download-url.
    key: Optional[str] = None  # S3 object key (server-generated at presign) - needed to clean up
    # storage on delete and to re-mint a presigned download URL for a second device.
    intrinsic_width: float
    intrinsic_height: float
    x: float  # normalized 0..1, relative to canvas WIDTH (both axes - see frontend's toNormalized)
    y: float
    scale: float  # uniform, relative to a base display width
    rotation: float  # radians
    z: int
    upload_status: str = "pending"  # "pending" | "uploaded" | "failed"


class NoteCreate(BaseModel):
    title: str = ""
    content: str = ""
    tags: List[Tag] = []
    is_pinned: bool = False
    linked_event_id: Optional[str] = None  # Deprecated: use linked_event_ids. Kept for old clients.
    linked_event_ids: List[str] = []
    images: List[str] = []  # Base64 encoded images
    attachments: List[Attachment] = []
    objects: List[ImageObject] = []
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
    objects: Optional[List[ImageObject]] = None
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
    objects: List[ImageObject] = []
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
