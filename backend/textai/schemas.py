from pydantic import BaseModel


class TranscribeBase64Request(BaseModel):
    audio_base64: str
    file_extension: str = "m4a"


class TextProcessRequest(BaseModel):
    text: str
    action: str  # "organize", "summarize", or "smart_format"
