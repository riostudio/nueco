from typing import Optional
from pydantic import BaseModel


class FeedbackCreate(BaseModel):
    sentiment: str  # "positive" | "negative"
    tag: Optional[str] = None
    text: str = ""
    note_count_at_submission: int = 0
    app_version: str = ""
    platform: str = ""
