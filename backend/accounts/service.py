"""Business logic for GDPR Art. 17 account erasure. Framework-agnostic: raises plain
exceptions (UserNotFoundError, IncorrectPasswordError) rather than fastapi.HTTPException.
backend/accounts/router.py translates them to HTTP status codes.
"""
import asyncio
import logging

import bcrypt
from motor.motor_asyncio import AsyncIOMotorDatabase

from attachments.service import delete_user_attachments

logger = logging.getLogger(__name__)

# Every user_id-scoped collection that must be wiped alongside the user doc itself.
ERASED_COLLECTIONS = ("notes", "events", "push_tokens", "push_receipts", "feature_events", "devices", "sessions")


class UserNotFoundError(Exception):
    pass


class IncorrectPasswordError(Exception):
    pass


class AccountsService:
    def __init__(self, db: AsyncIOMotorDatabase):
        self.db = db

    async def erase(self, user_id: str, password: str) -> None:
        """Permanently erase the user and ALL their data (GDPR Art. 17). Requires the account
        password as a confirmation. Irreversible."""
        # Re-verify the password (fetch fresh so we always have the current hash).
        user = await self.db.users.find_one({"id": user_id})
        if not user:
            raise UserNotFoundError()
        if not password or not bcrypt.checkpw(password.encode(), user.get("password", "").encode()):
            raise IncorrectPasswordError()

        # Wipe object storage first (attachments), then every DB record tied to the user.
        # to_thread: delete_user_attachments uses sync boto3 (paginated list+delete over the S3
        # prefix) - called directly, it blocks the single uvicorn worker's event loop for the
        # whole walk, stalling every other in-flight request for however long a user's
        # attachment count takes to page through.
        await asyncio.to_thread(delete_user_attachments, user_id)
        for coll in ERASED_COLLECTIONS:
            try:
                await self.db[coll].delete_many({"user_id": user_id})
            except Exception as e:
                logger.error(f"Account delete: failed clearing {coll} for {user_id}: {e}")
        await self.db.users.delete_one({"id": user_id})
        logger.info(f"Account deleted (GDPR erasure): user {user_id}")
