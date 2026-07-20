from datetime import datetime
from typing import Optional

# MongoDB document structures (used with motor)

def create_user_doc(
    user_id: str,
    email: str,
    name: str,
    password_hash: str
) -> dict:
    return {
        "id": user_id,
        "email": email.lower(),
        "name": name,
        "enc_version": None,  # E2EE (Stage 5): set once the client encrypts name with its DEK
        "password": password_hash,
        "email_verified": False,
        "verification_token": None,
        "verification_token_expiry": None,
        "reset_token": None,
        "reset_token_expiry": None,
        "failed_login_attempts": 0,
        "locked_until": None,
        "news_country": None,
        "news_outlet_ids": [],
        "custom_news_feeds": [],  # user-added [{id: "custom:<uuid>", name, feed_url}, ...]
        "daily_brew_show_verse": False,
        "created_at": datetime.utcnow(),
        "updated_at": datetime.utcnow()
    }

def create_device_doc(
    device_id: str,
    user_id: str,
    device_name: str,
    platform: str,
    fcm_token: Optional[str] = None
) -> dict:
    return {
        "id": device_id,
        "user_id": user_id,
        "device_name": device_name,
        "platform": platform,
        "fcm_token": fcm_token,
        "last_active_at": datetime.utcnow(),
        "registered_at": datetime.utcnow()
    }

def create_session_doc(
    session_id: str,
    user_id: str,
    device_id: str,
    refresh_token_hash: str,
    expires_at: datetime
) -> dict:
    return {
        "id": session_id,
        "user_id": user_id,
        "device_id": device_id,
        "refresh_token": refresh_token_hash,
        "expires_at": expires_at,
        "created_at": datetime.utcnow()
    }
