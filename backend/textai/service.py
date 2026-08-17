"""Business logic for voice transcription and AI text processing. Framework-agnostic: raises
plain exceptions rather than fastapi.HTTPException, and never types a parameter as UploadFile -
callers (backend/textai/router.py) unwrap the framework upload type into bytes/filename first.
"""
import json
import logging
import re
import time
from typing import Optional

from pydantic import ValidationError

from openai_client import get_openai_client
from .transcription import Transcript, resolve_transcription_provider, launch_shadow_transcription
from .schemas import (
    VALID_NOTE_TYPES,
    VALID_TEXT_ACTIONS,
    VALID_VOICE_INTENTS,
    ExtractArtifactsResponse,
    ExtractedEventOut,
    ExtractedItemOut,
    ExtractedTripOut,
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


EXTRACT_ARTIFACTS_PROMPT_TEMPLATE = """You are reading a voice-note transcript from a note-taking app. The FULL transcript is always
kept as the note itself - your job is only to spot optional add-on artifacts the speaker clearly
asked for. Extract conservatively: when in doubt, return nothing for that category. A story,
diary entry, or general thought is NOT an artifact.

Today's date is {reference_date}. The user's timezone is {timezone}. Resolve relative dates
("tomorrow", "next Tuesday") against these.

Look for, and extract ONLY if genuinely present:
- events: a scheduled thing with a stated or clearly-implied date/time.
- shopping_items: things to buy (groceries, supplies), each with its quantity if stated.
- checklist_items: discrete tasks/to-dos to get done.
- trip: a group of events described as one journey/plan with a shared name.

Every item you return MUST include "source_span": the exact words, copied verbatim from the
transcript, that justify that item. If you can't point at the words, don't return the item.

Respond with ONLY a JSON object of this exact shape:
{{
  "events": [{{"title": "", "start_time": "ISO 8601 with UTC offset", "end_time": "ISO or null", "location": "", "recurrence": null, "confidence": "high or low", "source_span": "verbatim words"}}],
  "shopping_items": [{{"text": "item with quantity", "confidence": "high or low", "source_span": "verbatim words"}}],
  "checklist_items": [{{"text": "task", "confidence": "high or low", "source_span": "verbatim words"}}],
  "trip": null
}}

For "trip", if present use: {{"name": "", "source_span": "verbatim words", "events": [same shape as events above]}}.
Keep "recurrence" as null unless the speaker clearly stated a repeat. No other text, no markdown code fence.

Here is the transcript:

{transcript}"""


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


async def transcribe_bytes(
    audio_bytes: bytes,
    file_extension: str,
    language: Optional[str] = None,
    diarization: Optional[str] = None,
) -> Transcript:
    provider = resolve_transcription_provider(diarization)
    started = time.monotonic()
    transcript = await provider.transcribe(audio_bytes, _normalize_extension(file_extension), language, diarization)
    latency_ms = (time.monotonic() - started) * 1000
    logger.info(f"Transcription via {provider.name} finished in {latency_ms:.0f}ms")
    # Fire-and-forget when TRANSCRIPTION_SHADOW is set; never blocks or fails this request.
    launch_shadow_transcription(
        audio_bytes, _normalize_extension(file_extension), language, diarization,
        provider.name, transcript.text, latency_ms,
    )
    # Return the whole transcript, not just .text: word-level timestamps (present when the
    # provider supplies them, e.g. Speechmatics) power the note editor's tap-to-seek player.
    return transcript


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


def _span_in_transcript(span, transcript: str) -> bool:
    """The plan's no-fabrication rule, enforced server-side: an extracted artifact is only real if
    its source_span appears verbatim in the transcript that produced it. Whitespace is normalized
    (the model may re-flow a line) but the words must match exactly - otherwise the item is a
    hallucination and gets dropped, never shipped to the client."""
    if not isinstance(span, str) or not span.strip():
        return False
    normalized_span = " ".join(span.split())
    normalized_transcript = " ".join(transcript.split())
    return normalized_span in normalized_transcript


def _extract_items(raw, transcript: str, model_cls, label: str) -> list:
    """Validate a list of model entries against the schema AND the transcript. Per-entry, not
    all-or-nothing: one fabricated item costs that item, not the four real ones beside it."""
    if not isinstance(raw, list):
        return []
    kept = []
    dropped_no_span = 0
    dropped_schema = 0
    for entry in raw:
        try:
            item = model_cls.model_validate(entry)
        except ValidationError:
            dropped_schema += 1
            continue
        if not _span_in_transcript(item.source_span, transcript):
            dropped_no_span += 1
            continue
        kept.append(item)
    # Counts only - never the dropped content (it's user-dictated and E2EE elsewhere in the app).
    if dropped_schema or dropped_no_span:
        logger.info(
            f"Artifact extraction: {label} dropped schema={dropped_schema} unverified_span={dropped_no_span}"
        )
    return kept


async def extract_artifacts(transcript: str, reference_date: str, timezone: str) -> ExtractArtifactsResponse:
    """Extract optional artifacts (events / shopping / checklist / trip) from a voice transcript.

    The full transcript is ALWAYS returned as note_content - artifacts are additive extras, never a
    replacement. Every artifact carries a source_span verified against the transcript, so the
    client can show "where did this come from" and a fabricated item can't survive this function.
    """
    client = get_openai_client()
    prompt = EXTRACT_ARTIFACTS_PROMPT_TEMPLATE.format(
        reference_date=reference_date, timezone=timezone, transcript=transcript,
    )

    logger.info(f"Extracting artifacts, transcript length: {len(transcript)}")
    response = await client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": "You are a careful assistant that extracts structured artifacts from voice-note transcripts. Respond only with a JSON object."},
            {"role": "user", "content": prompt},
        ],
        temperature=0.1,
        response_format={"type": "json_object"},
    )
    raw = (response.choices[0].message.content or "").strip()
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        raise AIResponseParseError("AI service returned an unexpected response")
    if not isinstance(parsed, dict):
        raise AIResponseParseError("AI service returned an unexpected response")

    events = _extract_items(parsed.get("events"), transcript, ExtractedEventOut, "events")
    shopping_items = _extract_items(parsed.get("shopping_items"), transcript, ExtractedItemOut, "shopping_items")
    checklist_items = _extract_items(parsed.get("checklist_items"), transcript, ExtractedItemOut, "checklist_items")

    trip = None
    raw_trip = parsed.get("trip")
    if isinstance(raw_trip, dict):
        try:
            candidate = ExtractedTripOut.model_validate(raw_trip)
        except ValidationError:
            candidate = None
        # The trip itself AND each of its events must be grounded in the transcript.
        if candidate and _span_in_transcript(candidate.source_span, transcript):
            grounded_events = [e for e in candidate.events if _span_in_transcript(e.source_span, transcript)]
            trip = ExtractedTripOut(
                name=candidate.name, source_span=candidate.source_span, events=grounded_events,
            )

    logger.info(
        "Artifact extraction successful: "
        f"events={len(events)} shopping={len(shopping_items)} checklist={len(checklist_items)} trip={'yes' if trip else 'no'}"
    )
    return ExtractArtifactsResponse(
        note_content=transcript,
        events=events,
        shopping_items=shopping_items,
        checklist_items=checklist_items,
        trip=trip,
    )
