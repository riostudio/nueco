from pydantic import BaseModel


class Attachment(BaseModel):
    """Shape of an attachment as embedded in a note document. Imported by the notes schemas
    in server.py - a note owns a list of these, this module owns the S3 side of producing them."""
    id: str
    key: str               # storage object key (server-generated)
    url: str               # download URL
    filename: str
    mime_type: str
    size_bytes: int
    uploaded_at: str


class PresignRequest(BaseModel):
    filename: str
    mime_type: str
    size: int


class DownloadUrlRequest(BaseModel):
    key: str
