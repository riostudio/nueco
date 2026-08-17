"""Business logic for events: payload size validation, reminder-scheduler field
computation, recurrence math, and persistence.

Framework-agnostic: raises plain exceptions (EventNotFoundError, EventPayloadTooLargeError)
rather than fastapi.HTTPException. backend/events/router.py translates them to HTTP responses.
`compute_reminder_fields`, `reminder_label`, and `next_occurrence_on_or_after` are also used
by server.py's push-reminder tick job, which lives outside this module.
"""
import uuid
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from dateutil.rrule import rrule, DAILY, WEEKLY, MONTHLY, YEARLY
from motor.motor_asyncio import AsyncIOMotorDatabase
from zoneinfo import ZoneInfo

from .schemas import EventCreate, EventUpdate, Recurrence


class EventNotFoundError(Exception):
    pass


class EventPayloadTooLargeError(Exception):
    pass


# ---- Reminder helpers ----

REMINDER_LABELS = {5: "5 minutes", 15: "15 minutes", 30: "30 minutes", 60: "1 hour", 1440: "1 day"}


def reminder_label(minutes) -> str:
    if not minutes:
        return "a moment"
    return REMINDER_LABELS.get(minutes, f"{minutes} minutes")


def compute_reminder_fields(start_time_iso: Optional[str], reminder_minutes: Optional[int]) -> dict:
    """Derive the scheduler fields for an event. `reminder_fire_at` = start - reminder_minutes.
    Past-due guard: if the fire time is already in the past (or no reminder), mark it 'sent' so a
    backfilled / late-edited event never queues a reminder for something already over."""
    if not reminder_minutes or not start_time_iso:
        return {"reminder_fire_at": None, "reminder_status": "sent", "reminder_claimed_at": None}
    try:
        st = datetime.fromisoformat(start_time_iso.replace("Z", "+00:00"))
        if st.tzinfo is None:
            st = st.replace(tzinfo=timezone.utc)
    except Exception:
        return {"reminder_fire_at": None, "reminder_status": "sent", "reminder_claimed_at": None}
    fire_at = st - timedelta(minutes=reminder_minutes)
    status = "sent" if fire_at <= datetime.now(timezone.utc) else "pending"
    return {"reminder_fire_at": fire_at.isoformat(), "reminder_status": status, "reminder_claimed_at": None}


# recurrence.freq -> dateutil.rrule frequency constant. Monthly/yearly need no extra kwargs -
# rrule already recurs on dtstart's own day-of-month / month-and-day by default.
_RRULE_FREQ = {"daily": DAILY, "weekly": WEEKLY, "monthly": MONTHLY, "yearly": YEARLY}

# Our `byweekday` contract is 0=Sunday..6=Saturday (matches JS `Date.getDay()`, see the
# `Recurrence` model). dateutil's rrule uses 0=Monday..6=Sunday. Map explicitly rather
# than via modular arithmetic to keep the off-by-one risk visible and testable.
_JS_WEEKDAY_TO_DATEUTIL = {0: 6, 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5}

# Cap generated occurrences so a no-`until` rule can't loop unbounded.
_RRULE_MAX_COUNT = 3650


def next_occurrence_on_or_after(
    start_time_iso: str,
    recurrence: Recurrence,
    timezone_name: Optional[str],
    after_dt: datetime,
) -> Optional[datetime]:
    """Return the next recurrence occurrence (as a UTC-aware datetime) at or after `after_dt`.

    Timezone-correct by construction: `start_time` is converted into the event's local
    `zoneinfo` wall-clock time, `dateutil.rrule` is stepped entirely in that naive local
    frame (so `byweekday`/`until` reasoning matches how a human reads "every Monday 9am"),
    and only the final result is converted back to a UTC instant. This means a DST
    transition shifts the UTC instant returned but never the local wall-clock hour.

    `until` is inclusive of that local calendar date. Falls back to UTC if `timezone_name`
    is missing or not a recognized IANA zone (defensive; a recurring event always gets a
    timezone at create time, so this path is not expected in normal operation).
    """
    try:
        st = datetime.fromisoformat(start_time_iso.replace("Z", "+00:00"))
        if st.tzinfo is None:
            st = st.replace(tzinfo=timezone.utc)
    except Exception:
        return None

    freq = _RRULE_FREQ.get(recurrence.freq)
    if freq is None:
        return None

    try:
        tz = ZoneInfo(timezone_name) if timezone_name else timezone.utc
    except Exception:
        tz = timezone.utc

    local_start = st.astimezone(tz).replace(tzinfo=None)
    local_after = after_dt.astimezone(tz).replace(tzinfo=None)

    kwargs = {"dtstart": local_start, "count": _RRULE_MAX_COUNT}
    if recurrence.freq == "weekly" and recurrence.byweekday:
        kwargs["byweekday"] = [_JS_WEEKDAY_TO_DATEUTIL[d] for d in recurrence.byweekday if d in _JS_WEEKDAY_TO_DATEUTIL]

    candidate = rrule(freq, **kwargs).after(local_after, inc=True)
    if candidate is None:
        return None

    if recurrence.until:
        try:
            until_date = datetime.fromisoformat(recurrence.until.replace("Z", "+00:00")).date()
        except Exception:
            until_date = None
        if until_date is not None and candidate.date() > until_date:
            return None

    return candidate.replace(tzinfo=tz).astimezone(timezone.utc)


# Same rationale as notes' ciphertext headroom (backend/notes/service.py): event fields may
# arrive as E2EE ciphertext (Stage 5), so the wire caps carry the same 5x headroom over the
# intended plaintext limits.
_CIPHERTEXT_HEADROOM = 5
MAX_EVENT_TITLE_CHARS = 200 * _CIPHERTEXT_HEADROOM
MAX_EVENT_DESCRIPTION_CHARS = 5_000 * _CIPHERTEXT_HEADROOM
MAX_EVENT_LOCATION_CHARS = 300 * _CIPHERTEXT_HEADROOM


# Pagination. 100 is deliberately the same number as the hard `.to_list(100)` cap this endpoint
# carried before it was paginated, so an older app build that sends no page params gets exactly
# the response it always got - while a newer client can page past it instead of silently seeing
# only the first 100 events and treating that as "all of them".
DEFAULT_EVENTS_PAGE_SIZE = 100
MAX_EVENTS_PAGE_SIZE = 100


def _validate_event_payload(title=None, description=None, location=None):
    """Reject oversized event fields. Only checks provided (non-None) fields."""
    if title is not None and len(title) > MAX_EVENT_TITLE_CHARS:
        raise EventPayloadTooLargeError(f"Title too long (max {MAX_EVENT_TITLE_CHARS} characters)")
    if description is not None and len(description) > MAX_EVENT_DESCRIPTION_CHARS:
        raise EventPayloadTooLargeError(f"Description too long (max {MAX_EVENT_DESCRIPTION_CHARS} characters)")
    if location is not None and len(location) > MAX_EVENT_LOCATION_CHARS:
        raise EventPayloadTooLargeError(f"Location too long (max {MAX_EVENT_LOCATION_CHARS} characters)")


def _normalize_updated_at(doc: dict) -> dict:
    """Read-side backfill: events created before `updated_at` existed only have `created_at`.
    Presenting `updated_at` on every response (rather than leaving it absent for old rows) is
    what lets the client's offline merge compare timestamps for ALL events instead of only new
    ones - without it, a legacy event has nothing to arbitrate with and the merge has to guess.
    Same no-migration-required approach as notes' _normalize_linked_event_ids."""
    if not doc.get("updated_at"):
        doc["updated_at"] = doc.get("created_at") or ""
    return doc


class EventsService:
    def __init__(self, db: AsyncIOMotorDatabase):
        self.db = db

    async def create(self, user_id: str, event: EventCreate) -> dict:
        _validate_event_payload(event.title, event.description, event.location)
        now = datetime.now(timezone.utc).isoformat()
        doc = {
            "id": str(uuid.uuid4()),
            "title": event.title,
            "description": event.description,
            "location": event.location,
            "start_time": event.start_time,
            "end_time": event.end_time,
            "all_day": event.all_day,
            "linked_note_ids": event.linked_note_ids,
            "reminder_minutes": event.reminder_minutes,
            "device_calendar_event_id": event.device_calendar_event_id,
            "user_id": user_id,
            "enc_version": event.enc_version,
            "created_at": now,
            # Client's clock wins when it sends one, same as notes - the offline merge compares
            # these two timestamps, so a server-stamped time from an earlier round trip could
            # otherwise sort as "newer" than a genuinely later local edit.
            "updated_at": event.updated_at or now,
            "recurrence": event.recurrence.model_dump() if event.recurrence else None,
            "timezone": event.timezone,
            "trip_id": event.trip_id,
            "google_event_id": event.google_event_id,
            "google_calendar_id": event.google_calendar_id,
            "google_event_updated": event.google_event_updated,
            "attendees": event.attendees,
            **compute_reminder_fields(event.start_time, event.reminder_minutes),
        }
        await self.db.events.insert_one(doc)
        doc.pop("_id", None)
        return doc

    async def list(
        self,
        user_id: str,
        month: Optional[int],
        year: Optional[int],
        page: int = 1,
        page_size: int = DEFAULT_EVENTS_PAGE_SIZE,
    ) -> List[dict]:
        query = {"user_id": user_id}
        if month is not None and year is not None:
            start = f"{year:04d}-{month:02d}-01"
            if month == 12:
                end = f"{year + 1:04d}-01-01"
            else:
                end = f"{year:04d}-{month + 1:02d}-01"
            query = {"user_id": user_id, "start_time": {"$gte": start, "$lt": end}}
        events = await self.db.events.find(query, {
            "_id": 0,
            "id": 1,
            "title": 1,
            "description": 1,
            "location": 1,
            "start_time": 1,
            "end_time": 1,
            "all_day": 1,
            "linked_note_ids": 1,
            "reminder_minutes": 1,
            "device_calendar_event_id": 1,
            "user_id": 1,
            "enc_version": 1,
            "created_at": 1,
            "updated_at": 1,
            "recurrence": 1,
            "timezone": 1,
            "trip_id": 1,
            "google_event_id": 1,
            "google_calendar_id": 1,
            "google_event_updated": 1,
            "attendees": 1,
        }).sort(
            # `id` is the tiebreaker, not decoration: start_time alone is not unique (all-day
            # events on the same date share it exactly), and skip/limit paging over a
            # non-deterministic order can hand the same document to two pages while skipping
            # another entirely. Covered by the (user_id, start_time, id) index.
            [("start_time", 1), ("id", 1)]
        ).skip((page - 1) * page_size).limit(page_size).to_list(page_size)
        return [_normalize_updated_at(e) for e in events]

    async def get(self, user_id: str, event_id: str) -> dict:
        event = await self.db.events.find_one({"id": event_id, "user_id": user_id}, {"_id": 0})
        if not event:
            raise EventNotFoundError()
        return _normalize_updated_at(event)

    async def get_batch(self, user_id: str, event_ids: List[str]) -> List[dict]:
        """Fetch multiple events by IDs in a single request (fixes N+1 query)"""
        if not event_ids:
            return []
        # Limit batch size to prevent abuse
        event_ids = event_ids[:50]
        events = await self.db.events.find(
            {"id": {"$in": event_ids}, "user_id": user_id},
            {"_id": 0}
        ).to_list(50)
        return [_normalize_updated_at(e) for e in events]

    async def update(self, user_id: str, event_id: str, update: EventUpdate) -> dict:
        _validate_event_payload(update.title, update.description, update.location)
        existing = await self.db.events.find_one({"id": event_id, "user_id": user_id})
        if not existing:
            raise EventNotFoundError()
        updates = {}
        for k, v in update.model_dump(exclude_unset=True).items():
            if v is None:
                # Only allow explicitly clearing these fields ("No reminder" / "turn off
                # recurrence" / "remove from trip"). Without this, an explicit null on an
                # autosaved full-object PUT is silently dropped instead of clearing the field -
                # see the bug this fixes: turning off an existing event's reminder/recurrence
                # via edit was previously a no-op. trip_id follows the same rule so
                # PUT /events/{id} {"trip_id": null} actually removes it from its trip.
                # The Google bridge fields follow the same rule so a Google disconnect can
                # clear the sync identity with an explicit null.
                if k in ("reminder_minutes", "recurrence", "trip_id", "google_event_id",
                         "google_calendar_id", "google_event_updated", "attendees"):
                    updates[k] = None
                continue
            updates[k] = v
        # Recompute the reminder scheduler fields when the timing (or recurrence, which the
        # future recurrence-aware tick job keys off of) changed. Only reset the send state
        # when the fire time actually moves (so unrelated edits don't re-fire an already-sent
        # reminder).
        if "start_time" in updates or "reminder_minutes" in updates or "recurrence" in updates:
            new_start = updates.get("start_time", existing.get("start_time"))
            new_minutes = updates.get("reminder_minutes", existing.get("reminder_minutes"))
            fields = compute_reminder_fields(new_start, new_minutes)
            if fields["reminder_fire_at"] != existing.get("reminder_fire_at"):
                updates.update(fields)
        # The loop above already picked up the client's own updated_at when it sent one, which
        # must win (see EventCreate.updated_at). Only stamp server time as the fallback for older
        # app builds. Deliberately not applied to the reminder scheduler's own $set writes in
        # reminders/service.py: those touch internal fields, not user-visible content, and
        # bumping the timestamp there would make the server copy beat a real local edit.
        updates.setdefault("updated_at", datetime.now(timezone.utc).isoformat())
        await self.db.events.update_one({"id": event_id, "user_id": user_id}, {"$set": updates})
        event = await self.db.events.find_one({"id": event_id, "user_id": user_id}, {"_id": 0})
        return _normalize_updated_at(event)

    async def delete(self, user_id: str, event_id: str) -> None:
        result = await self.db.events.delete_one({"id": event_id, "user_id": user_id})
        if result.deleted_count == 0:
            raise EventNotFoundError()
