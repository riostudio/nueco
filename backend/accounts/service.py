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

# Every collection whose documents carry a `user_id`, and which must therefore be wiped alongside
# the user doc itself.
#
# This list is the erasure contract, and it drifted from the schema: `trips`, `feedback` and
# `user_keys` were all written by other modules and never added here, so an itinerary, a feedback
# comment and the E2EE key-escrow record all outlived the account that owned them. Adding a
# collection to the app without adding it here is the whole failure mode, so it is now checked
# rather than trusted - tests/test_nueco_apis.py's TestErasureCoverage fails if any collection the
# backend writes is absent from both this tuple and NON_USER_SCOPED_COLLECTIONS below.
USER_ID_SCOPED_COLLECTIONS = (
    "notes",
    "events",
    "trips",
    "feedback",
    "user_keys",
    "push_tokens",
    "feature_events",
    "devices",
    "sessions",
)

# Collections that exist but are deliberately not erased by a `user_id` match, with the reason.
# Listing them is what lets the coverage test tell "handled another way" apart from "forgotten".
NON_USER_SCOPED_COLLECTIONS = {
    # Keyed by `id`, not `user_id` - deleted last, once everything hanging off it is gone.
    "users",
    # Has no user_id at all: reminders/service.py writes {ticket_id, event_id, token, ...}. It was
    # in the old list, so erasure ran delete_many({"user_id": ...}) against it and matched nothing -
    # covered on paper, untouched in practice, which is why _erase_push_receipts exists.
    "push_receipts",
    # Shadow-transcription eval records (textai/transcription.py): deliberately anonymous - no
    # user_id - and erased by the 7-day TTL index created in server.py instead.
    "transcription_shadow",
}


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
        # asyncio.to_thread: bcrypt is CPU-bound and deliberately slow (~250ms) - run
        # synchronously it would block this single-worker deployment's entire event loop for
        # that whole window on every account-deletion request. Same pattern as
        # auth/service.py's _verify_password.
        if not password or not await asyncio.to_thread(bcrypt.checkpw, password.encode(), user.get("password", "").encode()):
            raise IncorrectPasswordError()

        # Wipe object storage first (attachments), then every DB record tied to the user.
        # to_thread: delete_user_attachments uses sync boto3 (paginated list+delete over the S3
        # prefix) - called directly, it blocks the single uvicorn worker's event loop for the
        # whole walk, stalling every other in-flight request for however long a user's
        # attachment count takes to page through.
        await asyncio.to_thread(delete_user_attachments, user_id)
        # Before push_tokens: those tokens are the only way back to the receipt rows.
        await self._erase_push_receipts(user_id)
        for coll in USER_ID_SCOPED_COLLECTIONS:
            try:
                await self.db[coll].delete_many({"user_id": user_id})
            except Exception as e:
                logger.error(f"Account delete: failed clearing {coll} for {user_id}: {e}")
        await self.db.users.delete_one({"id": user_id})
        logger.info(f"Account deleted (GDPR erasure): user {user_id}")

    async def _erase_push_receipts(self, user_id: str) -> None:
        """Delete the push-receipt rows belonging to this user's devices.

        A receipt records an Expo push ticket against the token it was sent to, and a token
        identifies a device - personal data, with no user_id on the row to find it by. Nothing else
        ever deletes these (the receipt tick only flips `checked`, and the collection has no TTL
        index), so every reminder a user was ever sent left a permanent row naming their device.
        """
        try:
            tokens = [
                doc["token"]
                for doc in await self.db.push_tokens.find({"user_id": user_id}, {"token": 1}).to_list(None)
                if doc.get("token")
            ]
            if tokens:
                await self.db.push_receipts.delete_many({"token": {"$in": tokens}})
        except Exception as e:
            logger.error(f"Account delete: failed clearing push_receipts for {user_id}: {e}")
