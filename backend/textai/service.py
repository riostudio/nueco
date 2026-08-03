"""Business logic for voice transcription and AI text processing. Framework-agnostic: raises
plain exceptions rather than fastapi.HTTPException, and never types a parameter as UploadFile -
callers (backend/textai/router.py) unwrap the framework upload type into bytes/filename first.
"""
import json
import logging
import os
import tempfile
from typing import Optional

from pydantic import ValidationError

from openai_client import get_openai_client
from .schemas import (
    VALID_NOTE_TYPES,
    VALID_TEXT_ACTIONS,
    VALID_VOICE_INTENTS,
    TextProcessResponse,
    VoiceEventOut,
    VoiceIntentClassifyResponse,
)

logger = logging.getLogger(__name__)

SMART_FORMAT_PROMPT_TEMPLATE = """Classify the following note text as exactly one of these types:
- "recipe": a dish with ingredients and preparation steps
- "checklist": a list of discrete to-do items or tasks
- "meeting_notes": notes from a meeting/call (attendees, discussion, decisions, action items)
- "general": anything else, or text too short/unclear to classify

Then restructure it into clean HTML for that type:
- recipe: an optional <p> title line, then <h3>Ingredients</h3> followed by a <ul> with one
  ingredient (with its quantity) per <li>, then <h3>Steps</h3> followed by an <ol> with one step
  per <li>, in order.
- checklist: a <ul> with one <li>☐ item</li> per task (keep quantities/details).
- meeting_notes: only the headings that have real content, each an <h3> followed by a <ul>.
  Possible headings, in this order: "Attendees", "Discussion", "Decisions", "Action Items".
- general: lightly organize into readable paragraphs/bullets and fix grammar.

In every case, keep all original information (quantities, times, names, numbers) - do not invent
or drop anything.

Here's the text:

{text}

Respond with ONLY a JSON object of the shape {{"note_type": "recipe|checklist|meeting_notes|general", "html": "<the restructured HTML>"}}. No other text, no markdown code fence."""

VOICE_INTENT_PROMPT_TEMPLATE = """The user tapped the microphone button in a note-taking app and spoke the following. Decide what they meant to do:

- "note": dictating content for a note - a thought, list, memo, story, or anything not
  primarily about scheduling. This is the default when in doubt.
- "single_event": a request to schedule exactly one calendar event (e.g. "Remind me to call mom
  tomorrow at 5", "Set a reminder to take medication every Monday").
- "multiple_events": a request to schedule two or more separate, unrelated events in one go
  (e.g. "Schedule a dentist appointment Tuesday at 2 and a haircut Thursday at 10").
- "itinerary": describing a trip or multi-day plan made of several events that belong together
  as one group (e.g. "Plan my Tokyo trip: flight Friday at 9am, hotel check-in at 3pm, dinner
  reservation at 7").

Context: today's date is {reference_date} (the user's own local "today", not the server's), and
the user's timezone is {timezone}. Resolve every relative date/time ("tomorrow", "next Tuesday",
"in an hour", "every Monday") against this reference date and timezone.

Here's what they said:

{transcript}

Respond with ONLY a JSON object of this exact shape:
{{
  "intent": "note" | "single_event" | "multiple_events" | "itinerary",
  "trip_name": "short trip name, only when intent is \\"itinerary\\", else null",
  "events": [
    {{
      "title": "short event title",
      "start_time": "ISO 8601 datetime with a UTC offset, e.g. 2026-07-29T09:00:00+10:00",
      "end_time": "ISO 8601 datetime with a UTC offset, or null if not stated - if unclear, use 30 minutes after start_time",
      "location": "location mentioned, or empty string if none",
      "recurrence": null, or {{"freq": "daily|weekly|monthly|yearly", "byweekday": a list of integers 0-6 or null (0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday - this exact convention, NOT Monday=0), "until": "YYYY-MM-DD" or null}},
      "confidence": "high" if the date/time was stated clearly and unambiguously, "low" if you had to guess or the transcript was ambiguous
    }}
  ]
}}

When intent is "note", "events" MUST be an empty array and "trip_name" MUST be null - do not
extract events out of ordinary note content. When intent is anything else, "events" must contain
at least one item. No other text, no markdown code fence."""


class AIEmptyResponseError(Exception):
    pass


class AIResponseParseError(Exception):
    pass


class InvalidTextActionError(Exception):
    pass


def _normalize_extension(extension: str) -> str:
    extension = extension.lower()
    if not extension.startswith("."):
        extension = f".{extension}"
    # Whisper doesn't accept CAF; the iOS recorder's raw format maps cleanly onto m4a.
    if extension == ".caf":
        extension = ".m4a"
    return extension


async def transcribe_bytes(audio_bytes: bytes, file_extension: str, language: Optional[str] = None) -> str:
    extension = _normalize_extension(file_extension)
    client = get_openai_client()

    with tempfile.NamedTemporaryFile(delete=False, suffix=extension) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    try:
        with open(tmp_path, "rb") as audio_file:
            kwargs = {"model": "whisper-1", "file": audio_file}
            # Only pass language when we actually have a hint - an empty/unrecognized value
            # would force Whisper into that language instead of just falling back to auto-detect.
            if language:
                kwargs["language"] = language
            response = await client.audio.transcriptions.create(**kwargs)
        return response.text or ""
    finally:
        os.unlink(tmp_path)


async def process_text(text: str, action: str) -> TextProcessResponse:
    if action not in VALID_TEXT_ACTIONS:
        raise InvalidTextActionError("Invalid action. Use 'organize', 'summarize', or 'smart_format'")

    client = get_openai_client()

    if action == "organize":
        system_message = "You are a helpful assistant that organizes and structures text to make it easier to read."
        prompt = f"""Please organize and structure the following text to make it easier to read.
Add appropriate formatting like:
- Clear paragraphs
- Bullet points where appropriate
- Headers if needed
- Fix any grammar or punctuation issues

Keep the original meaning intact. Here's the text:

{text}

Return only the organized text, no explanations."""

        logger.info(f"Processing text with action: {action}, text length: {len(text)}")
        response = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": system_message},
                {"role": "user", "content": prompt},
            ],
            temperature=0.2,
        )
        processed_text = (response.choices[0].message.content or "").strip()
        if not processed_text:
            raise AIEmptyResponseError("AI service returned an empty response")
        logger.info(f"Text processing successful, result length: {len(processed_text)}")
        return TextProcessResponse(text=processed_text)

    elif action == "summarize":
        system_message = "You are a helpful assistant that summarizes text concisely while keeping key points."
        prompt = f"""Please summarize the following text concisely while keeping the key points.
Make it clear and easy to read.

Here's the text:

{text}

Return only the summary, no explanations."""

        logger.info(f"Processing text with action: {action}, text length: {len(text)}")
        response = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": system_message},
                {"role": "user", "content": prompt},
            ],
            temperature=0.2,
        )
        processed_text = (response.choices[0].message.content or "").strip()
        if not processed_text:
            raise AIEmptyResponseError("AI service returned an empty response")
        logger.info(f"Text processing successful, result length: {len(processed_text)}")
        return TextProcessResponse(text=processed_text)

    elif action == "smart_format":
        system_message = (
            "You are a helpful assistant that identifies what kind of note a piece of text is, "
            "and restructures it into clean HTML accordingly. Respond only with a JSON object."
        )
        prompt = SMART_FORMAT_PROMPT_TEMPLATE.format(text=text)

        logger.info(f"Processing text with action: {action}, text length: {len(text)}")
        response = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": system_message},
                {"role": "user", "content": prompt},
            ],
            temperature=0.2,
            response_format={"type": "json_object"},
        )
        raw = (response.choices[0].message.content or "").strip()
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            raise AIResponseParseError("AI service returned an unexpected response")
        if not isinstance(parsed, dict):
            raise AIResponseParseError("AI service returned an unexpected response")
        # An unrecognised note_type only picks the formatting template, so it degrades to "general"
        # rather than costing the user the restructured text the model did produce.
        note_type = parsed.get("note_type")
        if note_type not in VALID_NOTE_TYPES:
            note_type = "general"
        html = parsed.get("html")
        html = html.strip() if isinstance(html, str) else ""
        if not html:
            raise AIEmptyResponseError("AI service returned an empty response")
        logger.info(f"Smart format successful, detected type: {note_type}, result length: {len(html)}")
        return TextProcessResponse(text=html, note_type=note_type)

    # Unreachable: the action was checked against VALID_TEXT_ACTIONS on the way in.
    raise InvalidTextActionError("Invalid action. Use 'organize', 'summarize', or 'smart_format'")


def _parse_events(raw_events) -> list[VoiceEventOut]:
    """The LLM's "events" array -> validated events, dropping any entry the schema rejects.

    Every rule about what an event may contain lives in VoiceEventOut (see textai/schemas.py);
    this only decides what happens to an entry that breaks one. Per-entry validation rather than
    validating the list in one go is deliberate: a single unusable entry in a five-event itinerary
    should cost that entry, not the other four.
    """
    if not isinstance(raw_events, list):
        return []
    events: list[VoiceEventOut] = []
    for raw_event in raw_events:
        try:
            events.append(VoiceEventOut.model_validate(raw_event))
        except ValidationError as e:
            # Field names only, never the values: the fields carry what the user just dictated, and
            # note content is E2EE precisely so it never lands in the server's logs (same reason
            # textai/router.py logs transcript lengths instead of transcripts). Pydantic's own
            # message embeds the rejected input, so it must not be logged as-is.
            bad_fields = sorted({str(loc) for err in e.errors() for loc in err["loc"]})
            logger.info(f"Voice intent: dropped an unusable event (fields: {', '.join(bad_fields)})")
    return events


async def classify_voice_intent(
    transcript: str, reference_date: str, timezone_name: str,
) -> VoiceIntentClassifyResponse:
    """Classifies a note-editor voice-memo transcript as plain dictation vs. one or more calendar
    events vs. an itinerary (a trip of several events), and - for the non-"note" intents -
    extracts structured events via the same JSON-mode LLM pattern process_text's smart_format
    branch uses. Deliberately does no date-math or recurrence validation here, and never creates
    anything itself - that's events/service.py's and trips/service.py's job once the caller
    (after the user confirms/edits the result) actually saves via the normal create paths.
    """
    client = get_openai_client()
    system_message = (
        "You are a helpful assistant that classifies spoken voice-memo transcripts from a "
        "note-taking app and, when they're a scheduling request, extracts structured calendar "
        "events from them. Respond only with a JSON object."
    )
    prompt = VOICE_INTENT_PROMPT_TEMPLATE.format(
        reference_date=reference_date, timezone=timezone_name, transcript=transcript,
    )

    logger.info(f"Classifying voice intent, transcript length: {len(transcript)}")
    response = await client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": system_message},
            {"role": "user", "content": prompt},
        ],
        temperature=0.2,
        response_format={"type": "json_object"},
    )
    raw = (response.choices[0].message.content or "").strip()
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        raise AIResponseParseError("AI service returned an unexpected response")
    if not isinstance(parsed, dict):
        raise AIResponseParseError("AI service returned an unexpected response")

    # An unrecognised intent falls back to plain dictation - the pre-feature behaviour, and the one
    # outcome that can't lose what the user said.
    intent = parsed.get("intent") if parsed.get("intent") in VALID_VOICE_INTENTS else "note"

    if intent == "note":
        return VoiceIntentClassifyResponse(intent="note", trip_name=None, events=[])

    events = _parse_events(parsed.get("events"))
    if not events:
        raise AIEmptyResponseError("Could not extract an event from that recording")

    trip_name = parsed.get("trip_name") if intent == "itinerary" else None
    trip_name = trip_name.strip() if isinstance(trip_name, str) else None
    if intent == "itinerary" and not trip_name:
        trip_name = "New Trip"

    logger.info(f"Voice intent classification successful: intent={intent}, event_count={len(events)}")
    return VoiceIntentClassifyResponse(intent=intent, trip_name=trip_name, events=events)
