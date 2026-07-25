from typing import Optional

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
