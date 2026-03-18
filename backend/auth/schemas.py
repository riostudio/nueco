from pydantic import BaseModel
from typing import Optional

class RegisterDeviceRequest(BaseModel):
    device_id: str
    device_model: str
    os_version: str

class LinkAccountRequest(BaseModel):
    device_id: str
    email: Optional[str] = None
    mobile_number: Optional[str] = None
    password: Optional[str] = None

class ChangePasswordRequest(BaseModel):
    device_id: str
    current_password: str
    new_password: str

class UserResponse(BaseModel):
    device_id: str
    device_model: str
    os_version: str
    mobile_number: Optional[str]
    email: Optional[str]
    auth_provider: str
    email_verified: bool
    created_at: float
