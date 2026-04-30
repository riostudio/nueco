import os
from fastapi import APIRouter, Depends, HTTPException, Header, Request
from fastapi.responses import HTMLResponse
from motor.motor_asyncio import AsyncIOMotorDatabase
from typing import Optional
from dotenv import load_dotenv
from collections import defaultdict
import time

from .service import AuthService
from .schemas import (
    SignUpRequest, LoginRequest, ForgotPasswordRequest, ResetPasswordRequest,
    ChangePasswordRequest, RefreshTokenRequest, ResendVerificationRequest,
    AuthResponse, MessageResponse, UserResponse, SyncStatusResponse
)

load_dotenv()

router = APIRouter(prefix="/auth", tags=["auth"])

# ---- Rate Limiting for Auth ----
class AuthRateLimiter:
    def __init__(self):
        self.login_attempts = defaultdict(list)
        self.signup_attempts = defaultdict(list)
        self.reset_attempts = defaultdict(list)
    
    def _cleanup_old_attempts(self, attempts_list: list, window_seconds: int) -> list:
        now = time.time()
        return [t for t in attempts_list if now - t < window_seconds]
    
    def check_login_limit(self, ip: str, email: str) -> bool:
        """5 login attempts per email per minute, 10 per IP per minute"""
        now = time.time()
        
        # Per email limit (5/min)
        self.login_attempts[f"email:{email}"] = self._cleanup_old_attempts(
            self.login_attempts[f"email:{email}"], 60
        )
        if len(self.login_attempts[f"email:{email}"]) >= 5:
            return False
        
        # Per IP limit (10/min)
        self.login_attempts[f"ip:{ip}"] = self._cleanup_old_attempts(
            self.login_attempts[f"ip:{ip}"], 60
        )
        if len(self.login_attempts[f"ip:{ip}"]) >= 10:
            return False
        
        self.login_attempts[f"email:{email}"].append(now)
        self.login_attempts[f"ip:{ip}"].append(now)
        return True
    
    def check_signup_limit(self, ip: str) -> bool:
        """3 signups per IP per hour"""
        now = time.time()
        self.signup_attempts[ip] = self._cleanup_old_attempts(self.signup_attempts[ip], 3600)
        if len(self.signup_attempts[ip]) >= 3:
            return False
        self.signup_attempts[ip].append(now)
        return True
    
    def check_reset_limit(self, ip: str, email: str) -> bool:
        """3 password resets per email per hour, 5 per IP per hour"""
        now = time.time()
        
        self.reset_attempts[f"email:{email}"] = self._cleanup_old_attempts(
            self.reset_attempts[f"email:{email}"], 3600
        )
        if len(self.reset_attempts[f"email:{email}"]) >= 3:
            return False
        
        self.reset_attempts[f"ip:{ip}"] = self._cleanup_old_attempts(
            self.reset_attempts[f"ip:{ip}"], 3600
        )
        if len(self.reset_attempts[f"ip:{ip}"]) >= 5:
            return False
        
        self.reset_attempts[f"email:{email}"].append(now)
        self.reset_attempts[f"ip:{ip}"].append(now)
        return True

auth_rate_limiter = AuthRateLimiter()

def get_client_ip(request: Request) -> str:
    """Get client IP from request, handling proxies"""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"

# Dependency to get database
async def get_db():
    from server import db
    return db

async def get_current_user(authorization: Optional[str] = Header(None), db: AsyncIOMotorDatabase = Depends(get_db)):
    """Get current user from access token"""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    token = authorization.split(" ")[1]
    service = AuthService(db)
    user_id = await service.verify_access_token(token)
    
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    
    user = await service.get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    
    return user

@router.post("/signup", response_model=MessageResponse)
async def signup(request: SignUpRequest, req: Request, db: AsyncIOMotorDatabase = Depends(get_db)):
    """Create a new account"""
    # Rate limiting
    client_ip = get_client_ip(req)
    if not auth_rate_limiter.check_signup_limit(client_ip):
        raise HTTPException(status_code=429, detail="Too many signup attempts. Please try again later.")
    
    if request.password != request.confirm_password:
        raise HTTPException(status_code=400, detail="Passwords do not match")
    
    if len(request.password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")
    
    service = AuthService(db)
    success, message, _ = await service.signup(request.name, request.email, request.password)
    
    if not success:
        raise HTTPException(status_code=400, detail=message)
    
    return MessageResponse(message="Account created! Please check your email to verify your account.", success=True)

@router.post("/login", response_model=AuthResponse)
async def login(request: LoginRequest, req: Request, db: AsyncIOMotorDatabase = Depends(get_db)):
    """Log in to existing account"""
    # Rate limiting
    client_ip = get_client_ip(req)
    if not auth_rate_limiter.check_login_limit(client_ip, request.email):
        raise HTTPException(status_code=429, detail="Too many login attempts. Please try again later.")
    
    service = AuthService(db)
    success, message, data = await service.login(
        request.email, 
        request.password, 
        request.device_name, 
        request.platform
    )
    
    if not success:
        if data and data.get("needs_verification"):
            raise HTTPException(status_code=403, detail=message)
        raise HTTPException(status_code=401, detail=message)
    
    return AuthResponse(
        user=data["user"],
        access_token=data["access_token"],
        refresh_token=data["refresh_token"]
    )

@router.get("/verify-email/{token}", response_class=HTMLResponse)
async def verify_email(token: str, db: AsyncIOMotorDatabase = Depends(get_db)):
    """Verify email with token"""
    service = AuthService(db)
    success, message, email = await service.verify_email(token)
    
    app_url = os.getenv("APP_BASE_URL")
    if not app_url:
        raise HTTPException(status_code=500, detail="APP_BASE_URL environment variable is required")
    
    if not success:
        return f"""
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Verification Failed</title>
            <style>
                body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #FDFBF7; }}
                .container {{ text-align: center; padding: 40px; max-width: 400px; }}
                .icon {{ font-size: 64px; margin-bottom: 20px; }}
                h1 {{ color: #C62828; font-size: 24px; margin-bottom: 16px; }}
                p {{ color: #37474F; font-size: 16px; line-height: 1.5; }}
            </style>
        </head>
        <body>
            <div class="container">
                <div class="icon">❌</div>
                <h1>Verification Failed</h1>
                <p>{message}</p>
            </div>
        </body>
        </html>
        """
    
    first_letter = email[0].upper() if email else "✓"
    
    return f"""
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Email Verified - MemoPad</title>
        <style>
            body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #FDFBF7; }}
            .container {{ text-align: center; padding: 40px; max-width: 400px; }}
            .avatar {{ width: 80px; height: 80px; border-radius: 50%; background: #4CAF50; color: white; font-size: 40px; font-weight: 700; display: flex; justify-content: center; align-items: center; margin: 0 auto 20px; }}
            h1 {{ color: #121212; font-size: 24px; margin-bottom: 16px; }}
            p {{ color: #37474F; font-size: 16px; line-height: 1.5; }}
            .btn {{ display: inline-block; margin-top: 24px; padding: 16px 32px; background: #D84315; color: white; text-decoration: none; border-radius: 12px; font-size: 18px; font-weight: 600; }}
        </style>
    </head>
    <body>
        <div class="container">
            <div class="avatar">{first_letter}</div>
            <h1>Email Verified!</h1>
            <p>Your email has been verified successfully. You can now log in to MemoPad.</p>
            <a href="{app_url}" class="btn">Open MemoPad</a>
        </div>
    </body>
    </html>
    """

@router.post("/resend-verification", response_model=MessageResponse)
async def resend_verification(request: ResendVerificationRequest, db: AsyncIOMotorDatabase = Depends(get_db)):
    """Resend verification email"""
    service = AuthService(db)
    success, message = await service.resend_verification(request.email)
    return MessageResponse(message=message, success=success)

@router.post("/forgot-password", response_model=MessageResponse)
async def forgot_password(request: ForgotPasswordRequest, req: Request, db: AsyncIOMotorDatabase = Depends(get_db)):
    """Request password reset"""
    # Rate limiting
    client_ip = get_client_ip(req)
    if not auth_rate_limiter.check_reset_limit(client_ip, request.email):
        raise HTTPException(status_code=429, detail="Too many password reset attempts. Please try again later.")
    
    service = AuthService(db)
    success, message = await service.forgot_password(request.email)
    return MessageResponse(message=message, success=success)

@router.post("/reset-password", response_model=MessageResponse)
async def reset_password(request: ResetPasswordRequest, db: AsyncIOMotorDatabase = Depends(get_db)):
    """Reset password with token"""
    if request.new_password != request.confirm_password:
        raise HTTPException(status_code=400, detail="Passwords do not match")
    
    if len(request.new_password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")
    
    service = AuthService(db)
    success, message = await service.reset_password(request.token, request.new_password)
    
    if not success:
        raise HTTPException(status_code=400, detail=message)
    
    return MessageResponse(message=message, success=True)

@router.post("/change-password", response_model=MessageResponse)
async def change_password(
    request: ChangePasswordRequest, 
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db)
):
    """Change password for authenticated user"""
    if request.new_password != request.confirm_password:
        raise HTTPException(status_code=400, detail="Passwords do not match")
    
    if len(request.new_password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")
    
    service = AuthService(db)
    success, message = await service.change_password(
        current_user["id"], 
        request.current_password, 
        request.new_password
    )
    
    if not success:
        raise HTTPException(status_code=400, detail=message)
    
    return MessageResponse(message=message, success=True)

@router.post("/refresh", response_model=AuthResponse)
async def refresh_token(request: RefreshTokenRequest, db: AsyncIOMotorDatabase = Depends(get_db)):
    """Refresh access token"""
    service = AuthService(db)
    success, message, data = await service.refresh_access_token(request.refresh_token)
    
    if not success:
        raise HTTPException(status_code=401, detail=message)
    
    return AuthResponse(
        user=data["user"],
        access_token=data["access_token"],
        refresh_token=request.refresh_token  # Return same refresh token
    )

@router.post("/logout", response_model=MessageResponse)
async def logout(request: RefreshTokenRequest, db: AsyncIOMotorDatabase = Depends(get_db)):
    """Log out and invalidate session"""
    service = AuthService(db)
    success, message = await service.logout(request.refresh_token)
    return MessageResponse(message=message, success=True)

@router.get("/me", response_model=UserResponse)
async def get_me(current_user: dict = Depends(get_current_user)):
    """Get current user info"""
    return UserResponse(**current_user)

@router.get("/sync-status", response_model=SyncStatusResponse)
async def get_sync_status(
    current_user: dict = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_db)
):
    """Get sync status for current user"""
    service = AuthService(db)
    return await service.get_sync_status(current_user["id"])
