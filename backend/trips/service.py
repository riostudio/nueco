"""Business logic for trips: grouping several calendar events under a shared, named trip
(the "itinerary" feature - a trip's own timeline is just its linked events sorted by
start_time, computed client-side; no separate ordering/scheduling data lives here).

Framework-agnostic: raises plain exceptions (TripNotFoundError, TripPayloadTooLargeError)
rather than fastapi.HTTPException. backend/trips/router.py translates them to HTTP responses.
"""
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from motor.motor_asyncio import AsyncIOMotorDatabase

from .schemas import TripCreate, TripUpdate


class TripNotFoundError(Exception):
    pass


class TripPayloadTooLargeError(Exception):
    pass


# Same ciphertext-headroom rationale as notes/events (backend/notes/service.py): trip fields
# may arrive as E2EE ciphertext, so the wire caps carry the same 5x headroom over the intended
# plaintext limits.
_CIPHERTEXT_HEADROOM = 5
MAX_TRIP_NAME_CHARS = 100 * _CIPHERTEXT_HEADROOM
MAX_TRIP_DESCRIPTION_CHARS = 2_000 * _CIPHERTEXT_HEADROOM


def _validate_trip_payload(name=None, description=None):
    """Reject oversized trip fields. Only checks provided (non-None) fields."""
    if name is not None and len(name) > MAX_TRIP_NAME_CHARS:
        raise TripPayloadTooLargeError(f"Name too long (max {MAX_TRIP_NAME_CHARS} characters)")
    if description is not None and len(description) > MAX_TRIP_DESCRIPTION_CHARS:
        raise TripPayloadTooLargeError(f"Description too long (max {MAX_TRIP_DESCRIPTION_CHARS} characters)")


class TripsService:
    def __init__(self, db: AsyncIOMotorDatabase):
        self.db = db

    async def create(self, user_id: str, trip: TripCreate) -> dict:
        _validate_trip_payload(trip.name, trip.description)
        doc = {
            "id": str(uuid.uuid4()),
            "name": trip.name,
            "description": trip.description,
            "user_id": user_id,
            "enc_version": trip.enc_version,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        await self.db.trips.insert_one(doc)
        doc.pop("_id", None)
        return doc

    async def list(self, user_id: str) -> List[dict]:
        return await self.db.trips.find(
            {"user_id": user_id}, {"_id": 0}
        ).sort("created_at", -1).to_list(200)

    async def get(self, user_id: str, trip_id: str) -> dict:
        trip = await self.db.trips.find_one({"id": trip_id, "user_id": user_id}, {"_id": 0})
        if not trip:
            raise TripNotFoundError()
        return trip

    async def update(self, user_id: str, trip_id: str, update: TripUpdate) -> dict:
        _validate_trip_payload(update.name, update.description)
        result = await self.db.trips.update_one(
            {"id": trip_id, "user_id": user_id},
            {"$set": update.model_dump(exclude_unset=True)},
        )
        if result.matched_count == 0:
            raise TripNotFoundError()
        return await self.db.trips.find_one({"id": trip_id, "user_id": user_id}, {"_id": 0})

    async def delete(self, user_id: str, trip_id: str) -> None:
        # Unset trip_id on every event that referenced it BEFORE deleting the trip doc, so no
        # event is ever left pointing at a dangling trip id.
        await self.db.events.update_many(
            {"trip_id": trip_id, "user_id": user_id}, {"$set": {"trip_id": None}}
        )
        result = await self.db.trips.delete_one({"id": trip_id, "user_id": user_id})
        if result.deleted_count == 0:
            raise TripNotFoundError()
