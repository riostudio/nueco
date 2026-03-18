from fastapi import APIRouter, HTTPException, Depends
from motor.motor_asyncio import AsyncIOMotorDatabase
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

@router.get("/verify-email/{token}")
async def verify_email(token: str, db: AsyncIOMotorDatabase = Depends(get_db)):
    """Verify email with token"""
    service = AuthService(db)
    success, status = await service.verify_email(token)
    
    if status in ['invalid_token', 'expired_token']:
        raise HTTPException(status_code=400, detail={"success": False, "message": "Invalid or expired token"})
    
    return {"success": True, "message": "Email verified successfully"}
