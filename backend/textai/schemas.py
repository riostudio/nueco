from typing import List, Literal, Optional, get_args

from pydantic import BaseModel, Field, ValidationError, field_validator


class TranscribeBase64Request(BaseModel):
    audio_base64: str
    file_extension: str = "m4a"
    # ISO-639-1 hint, e.g. "en"/"id". The client no longer sends this - it used to default to
    # the device's OS locale, but that's not a reliable stand-in for the language actually
    # spoken into the mic (bilingual users, or a phone UI left in a different language than the
    # user speaks), and forcing Whisper toward the wrong locale mistranslated/garbled the
    # result. Left optional here in case a future UI adds an explicit spoken-language picker.
    language: Optional[str] = None
    # Conversation mode (plan.md M8) sends "speaker" to get per-word speaker labels from
    # providers that diarize (Speechmatics); text-only providers ignore it.
    diarization: Optional[str] = None


# The three text actions, and the note types the smart-format classifier may return. Declared as
# Literals so the values live in one place: the request/response models below constrain themselves,
# and service.py reads the allowed sets off these via get_args rather than repeating the strings.
TextAction = Literal["organize", "summarize", "smart_format"]
NoteType = Literal["recipe", "checklist", "meeting_notes", "general"]

VALID_TEXT_ACTIONS = frozenset(get_args(TextAction))
VALID_NOTE_TYPES = frozenset(get_args(NoteType))


class TextProcessRequest(BaseModel):
    # Deliberately `str` rather than TextAction: an unknown action is answered with a 400 and a
    # message naming the valid ones (see service.process_text), and typing the field would make
    # FastAPI reject it with a 422 first - a different status and body than the client handles.
    text: str
    action: str


class TextProcessResponse(BaseModel):
    text: str
    # Only the smart_format action classifies; organize/summarize leave this unset.
    note_type: Optional[NoteType] = None


class VoiceIntentClassifyRequest(BaseModel):
    transcript: str
    reference_date: str  # ISO date - the device's "today", avoids server-timezone skew
    timezone: str         # IANA name, e.g. "Australia/Sydney"


# What the voice-intent model is asked to return. These are closed sets: a value outside them is a
# malformed reply, not a new category, and the models below are what decide that - service.py no
# longer re-checks the same fields by hand against its own copies of these strings.
VoiceIntent = Literal["note", "single_event", "multiple_events", "itinerary"]
RecurrenceFreq = Literal["daily", "weekly", "monthly", "yearly"]
EventConfidence = Literal["high", "low"]

VALID_VOICE_INTENTS = frozenset(get_args(VoiceIntent))


class RecurrenceOut(BaseModel):
    # Mirrors events/schemas.py's Recurrence exactly (0=Sunday..6=Saturday byweekday convention -
    # see events/service.py's _JS_WEEKDAY_TO_DATEUTIL). Kept as a separate schema here rather than
    # importing events.schemas.Recurrence directly, so textai/ doesn't take a cross-module
    # dependency on events/ for what is otherwise an opaque passthrough shape.
    freq: RecurrenceFreq
    byweekday: Optional[List[int]] = None
    until: Optional[str] = None

    @field_validator("byweekday", mode="before")
    @classmethod
    def _drop_unusable_weekdays(cls, value):
        """A recurrence whose byweekday is unusable is still a usable recurrence - the series falls
        back to repeating on the start date's own weekday, which is better than losing the repeat.
        Booleans are rejected despite being ints in Python: `true` would silently mean Monday."""
        if not isinstance(value, list):
            return None
        if not all(isinstance(day, int) and not isinstance(day, bool) and 0 <= day <= 6 for day in value):
            return None
        return value

    @field_validator("until", mode="before")
    @classmethod
    def _only_string_until(cls, value):
        return value if isinstance(value, str) else None


class VoiceEventOut(BaseModel):
    # An event with no title or no start time can't be shown or scheduled, so min_length is what
    # makes service.py drop that entry (see classify_voice_intent) instead of returning a blank row.
    title: str = Field(min_length=1)
    start_time: str = Field(min_length=1)
    end_time: Optional[str] = None
    location: str = ""
    recurrence: Optional[RecurrenceOut] = None
    confidence: EventConfidence = "low"

    @field_validator("title", "start_time", mode="before")
    @classmethod
    def _require_text(cls, value):
        """Missing/blank/non-string -> "", which fails min_length and drops the event."""
        return value.strip() if isinstance(value, str) else ""

    @field_validator("end_time", mode="before")
    @classmethod
    def _blank_end_time_is_none(cls, value):
        """"" and null both mean "not stated"; the client derives a default end from start_time."""
        return value if isinstance(value, str) and value.strip() else None

    @field_validator("location", mode="before")
    @classmethod
    def _absent_location_is_empty(cls, value):
        return value if isinstance(value, str) else ""

    @field_validator("confidence", mode="before")
    @classmethod
    def _unknown_confidence_is_low(cls, value):
        """Confidence only drives whether the UI asks the user to confirm the time, so an
        unrecognised value degrades to "low" (ask) rather than costing the whole event."""
        return value if value in get_args(EventConfidence) else "low"

    @field_validator("recurrence", mode="before")
    @classmethod
    def _drop_malformed_recurrence(cls, value):
        if value is None or isinstance(value, RecurrenceOut):
            return value
        try:
            return RecurrenceOut.model_validate(value)
        except ValidationError:
            # Same trade as byweekday above, one level up: a rule we can't read costs the repeat,
            # not the event. It still gets created as a one-off the user can correct.
            return None


class VoiceIntentClassifyResponse(BaseModel):
    # "note": plain dictation, no events extracted - the caller should fall back to inserting
    # the raw transcript into the note body exactly as before this feature existed.
    # "single_event" / "multiple_events": one or more standalone calendar events.
    # "itinerary": several events that belong together as a trip - trip_name is set and the
    # caller is expected to create a Trip and link every event in `events` to it.
    intent: VoiceIntent
    trip_name: Optional[str] = None
    events: List[VoiceEventOut] = []
