from typing import List, Optional
from pydantic import BaseModel


class Recurrence(BaseModel):
    freq: str  # "daily" | "weekly" | "monthly" | "yearly"
    byweekday: Optional[List[int]] = None  # 0=Sunday..6=Saturday (matches JS Date.getDay()); weekly only
    until: Optional[str] = None  # ISO date string, inclusive


class EventCreate(BaseModel):
    title: str
    description: str = ""
    location: str = ""
    start_time: str
    end_time: str
    # True: start_time/end_time are date-only "YYYY-MM-DD" (no time-of-day, no instant/timezone
    # conversion - a calendar date, not an instant). False/absent: start_time/end_time are full
    # ISO-8601 instants, converted to the viewer's local time for display as today.
    all_day: bool = False
    linked_note_ids: List[str] = []
    reminder_minutes: Optional[int] = None  # Minutes before event to remind
    device_calendar_event_id: Optional[str] = None  # ID from device calendar
    enc_version: Optional[int] = None  # E2EE: when set, title/description/location are client-side ciphertext (AES-256-GCM). None/absent means legacy plaintext.
    recurrence: Optional[Recurrence] = None
    timezone: Optional[str] = None  # IANA name (e.g. "Australia/Sydney"); anchors recurrence math to wall-clock time across DST
    trip_id: Optional[str] = None  # Groups this event under a Trip (backend/trips/) - opaque id, no validation here.
    # Google Calendar bridge (client-side Google API sync). The backend is a passthrough store
    # for these - it never talks to Google. google_event_id/google_calendar_id identify the
    # mirrored Google event; google_event_updated is Google's `updated` timestamp used for
    # last-write-wins conflict resolution; attendees is the mirrored read-only attendee list.
    google_event_id: Optional[str] = None
    google_calendar_id: Optional[str] = None
    google_event_updated: Optional[str] = None
    attendees: Optional[List[dict]] = None
    # Client-authoritative timestamp for offline-first conflict resolution, same contract as
    # NoteCreate/NoteUpdate's (see notes/schemas.py for why the client's clock must win over the
    # server's). Optional so older app builds that don't send it still work - the service falls
    # back to server time.
    updated_at: Optional[str] = None


class EventUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    location: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    all_day: Optional[bool] = None
    linked_note_ids: Optional[List[str]] = None
    reminder_minutes: Optional[int] = None
    device_calendar_event_id: Optional[str] = None
    enc_version: Optional[int] = None
    recurrence: Optional[Recurrence] = None
    timezone: Optional[str] = None
    trip_id: Optional[str] = None
    google_event_id: Optional[str] = None
    google_calendar_id: Optional[str] = None
    google_event_updated: Optional[str] = None
    attendees: Optional[List[dict]] = None
    updated_at: Optional[str] = None


class EventResponse(BaseModel):
    id: str
    title: str
    description: str
    location: str = ""
    start_time: str
    end_time: str
    all_day: bool = False
    linked_note_ids: List[str]
    reminder_minutes: Optional[int] = None
    device_calendar_event_id: Optional[str] = None
    user_id: Optional[str] = None
    enc_version: Optional[int] = None
    created_at: str
    # Always present on the wire: events written before this field existed have it backfilled
    # from created_at on read (see events/service.py's _normalize_updated_at), so a client can
    # rely on it for conflict resolution without a Mongo migration.
    updated_at: str
    recurrence: Optional[Recurrence] = None
    timezone: Optional[str] = None
    trip_id: Optional[str] = None
    google_event_id: Optional[str] = None
    google_calendar_id: Optional[str] = None
    google_event_updated: Optional[str] = None
    attendees: Optional[List[dict]] = None


class PaginatedEventsResponse(BaseModel):
    events: List[EventResponse]
    total: int
    page: int
    page_size: int
    has_more: bool


class BatchEventIds(BaseModel):
    event_ids: List[str]
