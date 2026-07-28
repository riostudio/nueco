from typing import List, Optional

from pydantic import BaseModel


class TranscribeBase64Request(BaseModel):
    audio_base64: str
    file_extension: str = "m4a"
    # ISO-639-1 hint, e.g. "en"/"id". The client no longer sends this - it used to default to
    # the device's OS locale, but that's not a reliable stand-in for the language actually
    # spoken into the mic (bilingual users, or a phone UI left in a different language than the
    # user speaks), and forcing Whisper toward the wrong locale mistranslated/garbled the
    # result. Left optional here in case a future UI adds an explicit spoken-language picker.
    language: Optional[str] = None


class TextProcessRequest(BaseModel):
    text: str
    action: str  # "organize", "summarize", or "smart_format"


class VoiceIntentClassifyRequest(BaseModel):
    transcript: str
    reference_date: str  # ISO date - the device's "today", avoids server-timezone skew
    timezone: str         # IANA name, e.g. "Australia/Sydney"


class RecurrenceOut(BaseModel):
    # Mirrors events/schemas.py's Recurrence exactly (0=Sunday..6=Saturday byweekday convention -
    # see events/service.py's _JS_WEEKDAY_TO_DATEUTIL). Kept as a separate schema here rather than
    # importing events.schemas.Recurrence directly, so textai/ doesn't take a cross-module
    # dependency on events/ for what is otherwise an opaque passthrough shape.
    freq: str
    byweekday: Optional[List[int]] = None
    until: Optional[str] = None


class VoiceEventOut(BaseModel):
    title: str
    start_time: str
    end_time: Optional[str] = None
    location: str = ""
    recurrence: Optional[RecurrenceOut] = None
    confidence: str = "low"


class VoiceIntentClassifyResponse(BaseModel):
    # "note": plain dictation, no events extracted - the caller should fall back to inserting
    # the raw transcript into the note body exactly as before this feature existed.
    # "single_event" / "multiple_events": one or more standalone calendar events.
    # "itinerary": several events that belong together as a trip - trip_name is set and the
    # caller is expected to create a Trip and link every event in `events` to it.
    intent: str
    trip_name: Optional[str] = None
    events: List[VoiceEventOut] = []
