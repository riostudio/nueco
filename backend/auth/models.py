from typing import Optional
from pydantic import BaseModel, Field

class UserDocument:
    """MongoDB User Document Schema - used with motor async driver"""
    device_id: str
    device_model: str
    os_version: str
    mobile_number: Optional[str] = None
    email: Optional[str] = None
    password: Optional[str] = None
    auth_provider: str = 'local'
    email_verified: bool = False
    verification_token: Optional[str] = None
    verification_token_expiry: Optional[float] = None
    created_at: float
