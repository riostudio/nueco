from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import HTMLResponse
from motor.motor_asyncio import AsyncIOMotorDatabase
import os
from .schemas import RegisterDeviceRequest, LinkAccountRequest, ChangePasswordRequest, UserResponse
from .service import AuthService

router = APIRouter(prefix="/auth", tags=["auth"])

# Dependency to get database - will be injected from main app
def get_db():
    from server import db
    return db

@router.post("/device")
async def register_device(request: RegisterDeviceRequest, db: AsyncIOMotorDatabase = Depends(get_db)):
    """Register device or return existing user"""
    service = AuthService(db)
    user = await service.register_device(request)
    return {"success": True, "user": user}

@router.post("/link")
async def link_account(request: LinkAccountRequest, db: AsyncIOMotorDatabase = Depends(get_db)):
    """Link email/mobile/password to device user"""
    service = AuthService(db)
    user = await service.link_account(request)
    if not user:
        raise HTTPException(status_code=404, detail={"success": False, "message": "User not found"})
    return {"success": True, "user": user}

@router.post("/change-password")
async def change_password(request: ChangePasswordRequest, db: AsyncIOMotorDatabase = Depends(get_db)):
    """Change user password"""
    service = AuthService(db)
    success, status = await service.change_password(request)
    
    if status == 'not_found':
        raise HTTPException(status_code=404, detail={"success": False, "message": "User not found"})
    if status == 'no_password':
        raise HTTPException(status_code=400, detail={"success": False, "message": "No password set for this account"})
    if status == 'wrong_password':
        raise HTTPException(status_code=401, detail={"success": False, "message": "Incorrect current password"})
    
    return {"success": True, "message": "Password updated successfully"}

@router.get("/verify-email/{token}", response_class=HTMLResponse)
async def verify_email(token: str, db: AsyncIOMotorDatabase = Depends(get_db)):
    """Verify email with token and redirect to app"""
    service = AuthService(db)
    success, status, user_email = await service.verify_email(token)
    
    app_url = os.getenv("APP_BASE_URL", "https://note-builder-10.preview.emergentagent.com")
    
    if status in ['invalid_token', 'expired_token']:
        # Return error page
        return f"""
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Email Verification Failed</title>
            <style>
                body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #FDFBF7; }}
                .container {{ text-align: center; padding: 40px; max-width: 400px; }}
                .icon {{ font-size: 64px; margin-bottom: 20px; }}
                h1 {{ color: #C62828; font-size: 24px; margin-bottom: 16px; }}
                p {{ color: #37474F; font-size: 16px; line-height: 1.5; }}
                a {{ color: #D84315; text-decoration: none; font-weight: 600; }}
            </style>
        </head>
        <body>
            <div class="container">
                <div class="icon">❌</div>
                <h1>Verification Failed</h1>
                <p>This verification link is invalid or has expired. Please request a new verification email from the app.</p>
                <p><a href="{app_url}">Return to MemoPad</a></p>
            </div>
        </body>
        </html>
        """
    
    # Get first letter of email for display
    first_letter = user_email[0].upper() if user_email else "?"
    
    # Return success page with auto-redirect
    return f"""
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Email Verified - MemoPad</title>
        <meta http-equiv="refresh" content="3;url={app_url}">
        <style>
            body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #FDFBF7; }}
            .container {{ text-align: center; padding: 40px; max-width: 400px; }}
            .avatar {{ width: 80px; height: 80px; border-radius: 50%; background: #4CAF50; color: white; font-size: 40px; font-weight: 700; display: flex; justify-content: center; align-items: center; margin: 0 auto 20px; }}
            h1 {{ color: #121212; font-size: 24px; margin-bottom: 16px; }}
            p {{ color: #37474F; font-size: 16px; line-height: 1.5; }}
            .redirect {{ color: #78909C; font-size: 14px; margin-top: 24px; }}
            a {{ color: #D84315; text-decoration: none; font-weight: 600; }}
        </style>
    </head>
    <body>
        <div class="container">
            <div class="avatar">{first_letter}</div>
            <h1>Email Verified!</h1>
            <p>Your email has been successfully verified. You can now access all features of MemoPad.</p>
            <p class="redirect">Redirecting to MemoPad in 3 seconds...</p>
            <p><a href="{app_url}">Click here if not redirected</a></p>
        </div>
    </body>
    </html>
    """
