import time
import secrets
import bcrypt
from typing import Optional, Dict, Any
from motor.motor_asyncio import AsyncIOMotorDatabase
from .schemas import RegisterDeviceRequest, LinkAccountRequest, ChangePasswordRequest, UserResponse
from .email_service import send_confirmation_email

class AuthService:
    def __init__(self, db: AsyncIOMotorDatabase):
        self.db = db
        self.collection = db.users
    
    def _user_to_response(self, user: Dict[str, Any]) -> UserResponse:
        """Convert user document to response (excluding sensitive fields)"""
        return UserResponse(
            device_id=user['device_id'],
            device_model=user['device_model'],
            os_version=user['os_version'],
            mobile_number=user.get('mobile_number'),
            email=user.get('email'),
            auth_provider=user.get('auth_provider', 'local'),
            email_verified=user.get('email_verified', False),
            created_at=user.get('created_at', time.time())
        )
    
    async def register_device(self, request: RegisterDeviceRequest) -> UserResponse:
        """Register device or return existing user"""
        existing = await self.collection.find_one({'device_id': request.device_id})
        if existing:
            return self._user_to_response(existing)
        
        user_doc = {
            'device_id': request.device_id,
            'device_model': request.device_model,
            'os_version': request.os_version,
            'mobile_number': None,
            'email': None,
            'password': None,
            'auth_provider': 'local',
            'email_verified': False,
            'verification_token': None,
            'verification_token_expiry': None,
            'created_at': time.time()
        }
        await self.collection.insert_one(user_doc)
        return self._user_to_response(user_doc)
    
    async def link_account(self, request: LinkAccountRequest) -> Optional[UserResponse]:
        """Link email/mobile/password to existing device user"""
        user = await self.collection.find_one({'device_id': request.device_id})
        if not user:
            return None
        
        updates = {}
        if request.email is not None:
            updates['email'] = request.email
        if request.mobile_number is not None:
            updates['mobile_number'] = request.mobile_number
        if request.password is not None:
            hashed = bcrypt.hashpw(request.password.encode(), bcrypt.gensalt(rounds=10))
            updates['password'] = hashed.decode()
        
        if request.email:
            token = secrets.token_urlsafe(32)
            updates['verification_token'] = token
            updates['verification_token_expiry'] = time.time() + 86400
            send_confirmation_email(request.email, token)
        
        if updates:
            await self.collection.update_one(
                {'device_id': request.device_id},
                {'$set': updates}
            )
        
        updated_user = await self.collection.find_one({'device_id': request.device_id})
        return self._user_to_response(updated_user)
    
    async def change_password(self, request: ChangePasswordRequest) -> tuple[bool, str]:
        """Change user password. Returns (success, message)"""
        user = await self.collection.find_one({'device_id': request.device_id})
        if not user:
            return False, 'not_found'
        
        stored_password = user.get('password')
        if not stored_password:
            return False, 'no_password'
        
        if not bcrypt.checkpw(request.current_password.encode(), stored_password.encode()):
            return False, 'wrong_password'
        
        new_hash = bcrypt.hashpw(request.new_password.encode(), bcrypt.gensalt(rounds=10))
        await self.collection.update_one(
            {'device_id': request.device_id},
            {'$set': {'password': new_hash.decode()}}
        )
        return True, 'success'
    
    async def verify_email(self, token: str) -> tuple[bool, str]:
        """Verify email with token. Returns (success, message)"""
        user = await self.collection.find_one({'verification_token': token})
        if not user:
            return False, 'invalid_token'
        
        expiry = user.get('verification_token_expiry', 0)
        if expiry < time.time():
            return False, 'expired_token'
        
        await self.collection.update_one(
            {'verification_token': token},
            {
                '$set': {'email_verified': True},
                '$unset': {'verification_token': '', 'verification_token_expiry': ''}
            }
        )
        return True, 'success'
