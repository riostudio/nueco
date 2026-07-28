from typing import Optional
from pydantic import BaseModel


class TripCreate(BaseModel):
    name: str
    description: str = ""
    # E2EE: when set, name/description are client-side ciphertext (AES-256-GCM), same
    # convention as Event/Note. None/absent means legacy plaintext.
    enc_version: Optional[int] = None


class TripUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    enc_version: Optional[int] = None


class TripResponse(BaseModel):
    id: str
    name: str
    description: str = ""
    user_id: Optional[str] = None
    enc_version: Optional[int] = None
    created_at: str
