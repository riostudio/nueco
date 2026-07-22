import json
import logging
import os
import tempfile
from typing import Optional

from fastapi import HTTPException, UploadFile

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


async def transcribe_upload(file: UploadFile, language: Optional[str] = None) -> str:
    original_filename = file.filename or "recording.m4a"
    suffix = os.path.splitext(original_filename)[1] or ".m4a"
    content = await file.read()
    logger.info(f"Read {len(content)} bytes from uploaded file")
    return await transcribe_bytes(content, suffix, language)


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
            raise HTTPException(status_code=500, detail="AI service returned an empty response")
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
            raise HTTPException(status_code=500, detail="AI service returned an empty response")
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
            raise HTTPException(status_code=500, detail="AI service returned an unexpected response")
        note_type = parsed.get("note_type") if isinstance(parsed, dict) else None
        html = (parsed.get("html") or "").strip() if isinstance(parsed, dict) else ""
        if note_type not in NOTE_TYPES:
            note_type = "general"
        if not html:
            raise HTTPException(status_code=500, detail="AI service returned an empty response")
        logger.info(f"Smart format successful, detected type: {note_type}, result length: {len(html)}")
        return {"text": html, "note_type": note_type}

    else:
        raise HTTPException(status_code=400, detail="Invalid action. Use 'organize', 'summarize', or 'smart_format'")
