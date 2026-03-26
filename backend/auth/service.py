import os
import secrets
import bcrypt
import jwt
import logging
from datetime import datetime, timedelta
from typing import Optional, Tuple
from uuid import uuid4
from motor.motor_asyncio import AsyncIOMotorDatabase
from dotenv import load_dotenv

from .models import create_user_doc, create_device_doc, create_session_doc
from .schemas import UserResponse
from .email_service import send_verification_email, send_password_reset_email

load_dotenv()

logger = logging.getLogger(__name__)

# JWT Configuration
JWT_SECRET = os.getenv("JWT_SECRET", secrets.token_hex(32))
JWT_ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 15
REFRESH_TOKEN_EXPIRE_DAYS = 30
MAX_FAILED_ATTEMPTS = 5
LOCKOUT_DURATION_MINUTES = 30


class AuthService:
    def __init__(self, db: AsyncIOMotorDatabase):
        self.db = db
        self.users = db.users
        self.devices = db.devices
        self.sessions = db.sessions

    def _hash_password(self, password: str) -> str:
        return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12)).decode()

    def _verify_password(self, password: str, hashed: str) -> bool:
        return bcrypt.checkpw(password.encode(), hashed.encode())

    def _create_access_token(self, user_id: str) -> str:
        expire = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
        payload = {
            "sub": user_id,
            "type": "access",
            "exp": expire
        }
        return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)

    def _create_refresh_token(self) -> str:
        return secrets.token_urlsafe(64)

    def _hash_token(self, token: str) -> str:
        return bcrypt.hashpw(token.encode(), bcrypt.gensalt(rounds=10)).decode()

    def _verify_token_hash(self, token: str, hashed: str) -> bool:
        return bcrypt.checkpw(token.encode(), hashed.encode())

    def _get_user_id(self, user: dict) -> str:
        """Get user ID with fallback to _id for legacy users"""
        if "id" in user:
            return user["id"]
        # Fallback to MongoDB's _id if custom id doesn't exist
        return str(user.get("_id", ""))

    def _user_to_response(self, user: dict) -> UserResponse:
        return UserResponse(
            id=self._get_user_id(user),
            email=user["email"],
            name=user["name"],
            email_verified=user.get("email_verified", False),
            created_at=user.get("created_at", datetime.utcnow())
        )

    async def signup(self, name: str, email: str, password: str) -> Tuple[bool, str, Optional[dict]]:
        """Create new user account. Returns (success, message, user_data)"""
        email = email.lower()
        
        # Check if email already exists
        existing = await self.users.find_one({"email": email})
        if existing:
            return False, "An account with this email already exists. Want to log in instead?", None

        # Create user
        user_id = str(uuid4())
        password_hash = self._hash_password(password)
        verification_token = secrets.token_urlsafe(32)
        
        user_doc = create_user_doc(user_id, email, name, password_hash)
        user_doc["verification_token"] = verification_token
        user_doc["verification_token_expiry"] = datetime.utcnow() + timedelta(hours=24)
        
        # Note: Set email_verified=True for non-verified domain emails (dev mode)
        # For production with verified domain, remove this line
        # user_doc["email_verified"] = True
        
        await self.users.insert_one(user_doc)
        
        # Send verification email (may fail in dev due to domain restrictions)
        try:
            send_verification_email(email, name, verification_token)
        except Exception as e:
            logger.warning(f"Could not send verification email to {email}: {e}")
        
        logger.info(f"New user created: {email}")
        return True, "Account created successfully", {"user_id": user_id, "email": email, "name": name}

    async def login(
        self, 
        email: str, 
        password: str, 
        device_name: str, 
        platform: str
    ) -> Tuple[bool, str, Optional[dict]]:
        """Authenticate user and create session. Returns (success, message, auth_data)"""
        email = email.lower()
        
        user = await self.users.find_one({"email": email})
        if not user:
            return False, "Email or password is incorrect", None

        # Check if account is locked
        if user.get("locked_until") and user["locked_until"] > datetime.utcnow():
            remaining = (user["locked_until"] - datetime.utcnow()).seconds // 60
            return False, f"Account is locked. Try again in {remaining} minutes.", None

        # Verify password
        if not self._verify_password(password, user["password"]):
            # Increment failed attempts
            failed_attempts = user.get("failed_login_attempts", 0) + 1
            updates = {"failed_login_attempts": failed_attempts}
            
            if failed_attempts >= MAX_FAILED_ATTEMPTS:
                updates["locked_until"] = datetime.utcnow() + timedelta(minutes=LOCKOUT_DURATION_MINUTES)
                await self.users.update_one({"email": email}, {"$set": updates})
                return False, "Too many failed attempts. Account locked for 30 minutes.", None
            
            await self.users.update_one({"email": email}, {"$set": updates})
            return False, "Email or password is incorrect", None

        # Check email verification
        if not user.get("email_verified", False):
            return False, "Please verify your email before logging in", {"needs_verification": True, "email": email}

        # Reset failed attempts on successful login
        await self.users.update_one(
            {"email": email},
            {"$set": {"failed_login_attempts": 0, "locked_until": None}}
        )

        # Create or update device
        user_id = self._get_user_id(user)
        device_id = str(uuid4())
        device_doc = create_device_doc(device_id, user_id, device_name, platform)
        await self.devices.insert_one(device_doc)

        # Create session with refresh token
        refresh_token = self._create_refresh_token()
        session_id = str(uuid4())
        expires_at = datetime.utcnow() + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
        
        session_doc = create_session_doc(
            session_id, 
            user_id, 
            device_id, 
            self._hash_token(refresh_token),
            expires_at
        )
        await self.sessions.insert_one(session_doc)

        # Create access token
        access_token = self._create_access_token(user_id)

        logger.info(f"User logged in: {email}")
        return True, "Login successful", {
            "user": self._user_to_response(user),
            "access_token": access_token,
            "refresh_token": refresh_token
        }

    async def verify_email(self, token: str) -> Tuple[bool, str, Optional[str]]:
        """Verify email with token. Returns (success, message, user_email)"""
        user = await self.users.find_one({"verification_token": token})
        if not user:
            return False, "Invalid verification link", None

        if user.get("verification_token_expiry") and user["verification_token_expiry"] < datetime.utcnow():
            return False, "Verification link has expired. Please request a new one.", None

        await self.users.update_one(
            {"email": user["email"]},
            {
                "$set": {"email_verified": True},
                "$unset": {"verification_token": "", "verification_token_expiry": ""}
            }
        )

        logger.info(f"Email verified: {user['email']}")
        return True, "Email verified successfully", user["email"]

    async def resend_verification(self, email: str) -> Tuple[bool, str]:
        """Resend verification email"""
        email = email.lower()
        user = await self.users.find_one({"email": email})
        
        if not user:
            return True, "If an account exists, a verification email has been sent"  # Don't reveal if email exists
        
        if user.get("email_verified"):
            return False, "Email is already verified"

        verification_token = secrets.token_urlsafe(32)
        await self.users.update_one(
            {"email": email},
            {
                "$set": {
                    "verification_token": verification_token,
                    "verification_token_expiry": datetime.utcnow() + timedelta(hours=24)
                }
            }
        )
        
        send_verification_email(email, user["name"], verification_token)
        return True, "Verification email sent"

    async def forgot_password(self, email: str) -> Tuple[bool, str]:
        """Send password reset email"""
        email = email.lower()
        user = await self.users.find_one({"email": email})
        
        # Always return success to not reveal if email exists
        if not user:
            return True, "If an account exists, a password reset email has been sent"

        reset_token = secrets.token_urlsafe(32)
        await self.users.update_one(
            {"email": email},
            {
                "$set": {
                    "reset_token": reset_token,
                    "reset_token_expiry": datetime.utcnow() + timedelta(minutes=30)
                }
            }
        )
        
        send_password_reset_email(email, user["name"], reset_token)
        logger.info(f"Password reset requested: {email}")
        return True, "If an account exists, a password reset email has been sent"

    async def reset_password(self, token: str, new_password: str) -> Tuple[bool, str]:
        """Reset password with token"""
        user = await self.users.find_one({"reset_token": token})
        if not user:
            return False, "Invalid or expired reset link"

        if user.get("reset_token_expiry") and user["reset_token_expiry"] < datetime.utcnow():
            return False, "Reset link has expired. Please request a new one."

        password_hash = self._hash_password(new_password)
        user_id = self._get_user_id(user)
        
        # Update password and invalidate all sessions (force re-login)
        await self.users.update_one(
            {"email": user["email"]},
            {
                "$set": {"password": password_hash},
                "$unset": {"reset_token": "", "reset_token_expiry": ""}
            }
        )
        
        # Invalidate all refresh tokens for this user
        await self.sessions.delete_many({"user_id": user_id})
        
        logger.info(f"Password reset completed: {user['email']}")
        return True, "Password reset successful. Please log in with your new password."

    async def change_password(self, user_id: str, current_password: str, new_password: str) -> Tuple[bool, str]:
        """Change password for authenticated user"""
        user = await self.users.find_one({"id": user_id})
        if not user:
            return False, "User not found"

        if not self._verify_password(current_password, user["password"]):
            return False, "Current password is incorrect"

        password_hash = self._hash_password(new_password)
        await self.users.update_one(
            {"id": user_id},
            {"$set": {"password": password_hash, "updated_at": datetime.utcnow()}}
        )
        
        logger.info(f"Password changed: {user['email']}")
        return True, "Password changed successfully"

    async def refresh_access_token(self, refresh_token: str) -> Tuple[bool, str, Optional[dict]]:
        """Refresh access token. Returns (success, message, tokens)"""
        # Find session with this refresh token
        sessions = await self.sessions.find().to_list(length=1000)
        
        valid_session = None
        for session in sessions:
            if self._verify_token_hash(refresh_token, session["refresh_token"]):
                valid_session = session
                break
        
        if not valid_session:
            return False, "Invalid refresh token", None

        if valid_session["expires_at"] < datetime.utcnow():
            await self.sessions.delete_one({"id": valid_session["id"]})
            return False, "Session expired. Please log in again.", None

        # Get user
        user = await self.users.find_one({"id": valid_session["user_id"]})
        if not user:
            return False, "User not found", None

        # Create new access token
        access_token = self._create_access_token(user["id"])
        
        # Update device last active
        await self.devices.update_one(
            {"id": valid_session["device_id"]},
            {"$set": {"last_active_at": datetime.utcnow()}}
        )

        return True, "Token refreshed", {
            "user": self._user_to_response(user),
            "access_token": access_token
        }

    async def logout(self, refresh_token: str) -> Tuple[bool, str]:
        """Logout and invalidate session"""
        sessions = await self.sessions.find().to_list(length=1000)
        
        for session in sessions:
            if self._verify_token_hash(refresh_token, session["refresh_token"]):
                await self.sessions.delete_one({"id": session["id"]})
                logger.info(f"User logged out, session deleted")
                return True, "Logged out successfully"
        
        return True, "Logged out"  # Still return success even if token not found

    async def get_user_by_id(self, user_id: str) -> Optional[dict]:
        """Get user by ID"""
        user = await self.users.find_one({"id": user_id})
        if user:
            return self._user_to_response(user).model_dump()
        return None

    async def verify_access_token(self, token: str) -> Optional[str]:
        """Verify access token and return user_id if valid"""
        try:
            payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
            if payload.get("type") != "access":
                return None
            return payload.get("sub")
        except jwt.ExpiredSignatureError:
            return None
        except jwt.InvalidTokenError:
            return None

    async def get_sync_status(self, user_id: str) -> dict:
        """Get sync status for user"""
        user = await self.users.find_one({"id": user_id})
        notes_count = await self.db.notes.count_documents({"user_id": user_id})
        
        return {
            "notes_count": notes_count,
            "synced": True,
            "user_name": user["name"] if user else "User"
        }
