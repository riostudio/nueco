from typing import Optional

from pydantic import BaseModel


class TranscribeBase64Request(BaseModel):
    audio_base64: str
    file_extension: str = "m4a"
    # ISO-639-1 hint (e.g. "en", "id") from the device's own locale. Whisper transcribes in
    # whatever language it detects rather than translating - but detection runs on the audio
    # alone, and a short clip or an accented speaker gives it too little signal, so it can
    # lock onto the wrong (often closely related) language for the whole clip. Telling it the
    # expected language up front skips that guess entirely.
    language: Optional[str] = None


class TextProcessRequest(BaseModel):
    text: str
    action: str  # "organize", "summarize", or "smart_format"
