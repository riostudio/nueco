from pydantic import BaseModel, EmailStr
from typing import List, Optional
from datetime import datetime

# Request schemas
class SignUpRequest(BaseModel):
    name: str
    email: EmailStr
    password: str
    confirm_password: str

class LoginRequest(BaseModel):
    email: EmailStr
    password: str
    device_name: str = "Unknown Device"
    platform: str = "unknown"

class ForgotPasswordRequest(BaseModel):
    email: EmailStr

class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str
    confirm_password: str

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str
    confirm_password: str

class RefreshTokenRequest(BaseModel):
    refresh_token: str

class ResendVerificationRequest(BaseModel):
    email: EmailStr

class DeleteUnverifiedRequest(BaseModel):
    email: EmailStr

class UpdateNameRequest(BaseModel):
    name: str
    enc_version: Optional[int] = None

class UpdateNewsPreferencesRequest(BaseModel):
    country: str
    outlet_ids: List[str] = []
    show_verse: bool = False
    # Defaults False so an older app build that doesn't send this field doesn't silently
    # switch quotes on for someone who never asked for them.
    show_quote: bool = False

# Response schemas
class UserResponse(BaseModel):
    id: str
    email: str
    name: str
    enc_version: Optional[int] = None
    email_verified: bool
    created_at: datetime
    news_country: Optional[str] = None
    news_outlet_ids: List[str] = []
    daily_brew_show_verse: bool = False
    daily_brew_show_quote: bool = False
    daily_brew_enabled: bool = False

class AuthResponse(BaseModel):
    user: UserResponse
    access_token: str
    refresh_token: str
    token_type: str = "bearer"

class MessageResponse(BaseModel):
    message: str
    success: bool = True

class SyncStatusResponse(BaseModel):
    notes_count: int
    synced: bool
    user_name: str
