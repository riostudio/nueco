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
    linked_note_ids: List[str] = []
    reminder_minutes: Optional[int] = None  # Minutes before event to remind
    device_calendar_event_id: Optional[str] = None  # ID from device calendar
    enc_version: Optional[int] = None  # E2EE: when set, title/description/location are client-side ciphertext (AES-256-GCM). None/absent means legacy plaintext.
    recurrence: Optional[Recurrence] = None
    timezone: Optional[str] = None  # IANA name (e.g. "Australia/Sydney"); anchors recurrence math to wall-clock time across DST


class EventUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    location: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    linked_note_ids: Optional[List[str]] = None
    reminder_minutes: Optional[int] = None
    device_calendar_event_id: Optional[str] = None
    enc_version: Optional[int] = None
    recurrence: Optional[Recurrence] = None
    timezone: Optional[str] = None


class EventResponse(BaseModel):
    id: str
    title: str
    description: str
    location: str = ""
    start_time: str
    end_time: str
    linked_note_ids: List[str]
    reminder_minutes: Optional[int] = None
    device_calendar_event_id: Optional[str] = None
    user_id: Optional[str] = None
    enc_version: Optional[int] = None
    created_at: str
    recurrence: Optional[Recurrence] = None
    timezone: Optional[str] = None


class PaginatedEventsResponse(BaseModel):
    events: List[EventResponse]
    total: int
    page: int
    page_size: int
    has_more: bool


class BatchEventIds(BaseModel):
    event_ids: List[str]
