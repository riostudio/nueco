from pydantic import BaseModel, EmailStr
from typing import Optional
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

# Response schemas
class UserResponse(BaseModel):
    id: str
    email: str
    name: str
    email_verified: bool
    created_at: datetime

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
