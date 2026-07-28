"""Business logic for voice transcription and AI text processing. Framework-agnostic: raises
plain exceptions rather than fastapi.HTTPException, and never types a parameter as UploadFile -
callers (backend/textai/router.py) unwrap the framework upload type into bytes/filename first.
"""
import json
import logging
import os
import tempfile
from typing import Optional

from openai_client import get_openai_client

logger = logging.getLogger(__name__)

# Note types the smart-format classifier recognizes. "general" is the fallback for anything
# that isn't clearly one of the others (or text too short/unclear to classify).
NOTE_TYPES = {"recipe", "checklist", "meeting_notes", "general"}

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

# freq values recognized on the way back out - anything else is treated as malformed and the
# whole recurrence is dropped (see _parse_recurrence) rather than failing the entire extraction.
_VALID_RECURRENCE_FREQ = {"daily", "weekly", "monthly", "yearly"}

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


async def process_text(text: str, action: str) -> dict:
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
        return {"text": processed_text}

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
        return {"text": processed_text}

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
        note_type = parsed.get("note_type") if isinstance(parsed, dict) else None
        html = (parsed.get("html") or "").strip() if isinstance(parsed, dict) else ""
        if note_type not in NOTE_TYPES:
            note_type = "general"
        if not html:
            raise AIEmptyResponseError("AI service returned an empty response")
        logger.info(f"Smart format successful, detected type: {note_type}, result length: {len(html)}")
        return {"text": html, "note_type": note_type}

    else:
        raise InvalidTextActionError("Invalid action. Use 'organize', 'summarize', or 'smart_format'")


_VALID_INTENTS = {"note", "single_event", "multiple_events", "itinerary"}


def _parse_recurrence(raw_recurrence) -> Optional[dict]:
    """Defensive extraction, same style as smart_format's note_type handling: a malformed
    recurrence shape is dropped (event still gets created as a one-off) rather than failing
    the whole extraction over one bad sub-field."""
    if not (isinstance(raw_recurrence, dict) and raw_recurrence.get("freq") in _VALID_RECURRENCE_FREQ):
        return None
    byweekday = raw_recurrence.get("byweekday")
    if not (isinstance(byweekday, list) and all(isinstance(d, int) and 0 <= d <= 6 for d in byweekday)):
        byweekday = None
    until = raw_recurrence.get("until")
    return {
        "freq": raw_recurrence["freq"],
        "byweekday": byweekday,
        "until": until if isinstance(until, str) else None,
    }


def _parse_event(raw_event: dict) -> Optional[dict]:
    """One entry from the LLM's "events" array -> our event shape, or None if the entry is too
    malformed to use (missing title/start_time) - skipped rather than failing the whole batch."""
    if not isinstance(raw_event, dict):
        return None
    title = (raw_event.get("title") or "").strip()
    start_time = (raw_event.get("start_time") or "").strip()
    if not title or not start_time:
        return None
    confidence = raw_event.get("confidence") if raw_event.get("confidence") in ("high", "low") else "low"
    return {
        "title": title,
        "start_time": start_time,
        "end_time": raw_event.get("end_time") or None,
        "location": raw_event.get("location") or "",
        "recurrence": _parse_recurrence(raw_event.get("recurrence")),
        "confidence": confidence,
    }


async def classify_voice_intent(transcript: str, reference_date: str, timezone_name: str) -> dict:
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

    intent = parsed.get("intent") if parsed.get("intent") in _VALID_INTENTS else "note"

    if intent == "note":
        return {"intent": "note", "trip_name": None, "events": []}

    raw_events = parsed.get("events")
    events = [_parse_event(e) for e in raw_events] if isinstance(raw_events, list) else []
    events = [e for e in events if e is not None]

    if not events:
        raise AIEmptyResponseError("Could not extract an event from that recording")

    trip_name = (parsed.get("trip_name") or "").strip() if intent == "itinerary" else None
    if intent == "itinerary" and not trip_name:
        trip_name = "New Trip"

    logger.info(f"Voice intent classification successful: intent={intent}, event_count={len(events)}")
    return {"intent": intent, "trip_name": trip_name, "events": events}
