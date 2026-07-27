"""Business logic for the feedback-toast endpoint: validation, rate limiting, and best-effort
AI triage of free-text comments. Framework-agnostic: raises plain exceptions
(InvalidSentimentError, FeedbackTextTooLongError, FeedbackRateLimitedError) rather than
fastapi.HTTPException. backend/feedback/router.py translates them to HTTP status codes.
"""
import json
import logging
import time
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from typing import Optional

from motor.motor_asyncio import AsyncIOMotorDatabase

from openai_client import get_openai_client
from .schemas import FeedbackCreate

logger = logging.getLogger(__name__)

MAX_FEEDBACK_TEXT_CHARS = 2000
RATE_LIMIT_MAX_REQUESTS = 5
RATE_LIMIT_WINDOW_SECONDS = 86400  # 24h


class InvalidSentimentError(Exception):
    pass


class FeedbackTextTooLongError(Exception):
    pass


class FeedbackRateLimitedError(Exception):
    pass


class RateLimiter:
    """Generic in-memory sliding-window limiter. Only feedback submissions use this today -
    kept local to this module rather than a shared server-wide utility until a second consumer
    shows up (see CLAUDE.md: avoid premature shared infrastructure)."""

    def __init__(self):
        self.requests: dict[str, list[float]] = defaultdict(list)

    def is_allowed(self, key: str, max_requests: int, window_seconds: int) -> bool:
        now = time.time()
        self.requests[key] = [t for t in self.requests[key] if now - t < window_seconds]
        if len(self.requests[key]) >= max_requests:
            return False
        self.requests[key].append(now)
        return True


# Module-level singleton: rate-limit state must persist across requests within this process,
# not be recreated per FeedbackService(db) instantiation.
_rate_limiter = RateLimiter()


def _parse_ai_triage(raw: str) -> dict:
    """Best-effort parse of the triage model's JSON reply, tolerating a markdown code fence."""
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:]
    return json.loads(cleaned)


class FeedbackService:
    def __init__(self, db: AsyncIOMotorDatabase):
        self.db = db

    async def submit(self, user_id: str, body: FeedbackCreate) -> dict:
        """Store a feedback-toast response, AI-triaging any free-text comment (never blocks the
        submission if triage fails -- the record is saved either way)."""
        if body.sentiment not in ("positive", "negative"):
            raise InvalidSentimentError()
        if len(body.text) > MAX_FEEDBACK_TEXT_CHARS:
            raise FeedbackTextTooLongError()
        if not _rate_limiter.is_allowed(f"feedback:{user_id}", RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_SECONDS):
            raise FeedbackRateLimitedError()

        doc = {
            "id": str(uuid.uuid4()),
            "user_id": user_id,
            "sentiment": body.sentiment,
            "tag": body.tag,
            "text": body.text,
            "aiCategory": None,
            "aiPriority": None,
            "aiSummary": None,
            "appVersion": body.app_version,
            "platform": body.platform,
            "noteCountAtSubmission": body.note_count_at_submission,
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "status": "new",
        }

        if body.text.strip():
            try:
                client = get_openai_client()
                response = await client.chat.completions.create(
                    model="gpt-4o-mini",
                    messages=[
                        {
                            "role": "system",
                            "content": (
                                "You triage user feedback for a note-taking app. Respond with ONLY "
                                'compact JSON: {"category": one of bug|feature_request|ux_friction|'
                                'praise|unclear, "priority": one of low|medium|high|urgent (urgent = '
                                'crash, data loss, or billing issue), "summary": a single short sentence}.'
                            ),
                        },
                        {"role": "user", "content": body.text},
                    ],
                    temperature=0.2,
                )
                parsed = _parse_ai_triage(response.choices[0].message.content or "")
                doc["aiCategory"] = parsed.get("category")
                doc["aiPriority"] = parsed.get("priority")
                doc["aiSummary"] = parsed.get("summary")
            except Exception as e:
                logger.error(f"Feedback AI triage failed: {e}")

        await self.db.feedback.insert_one(doc)
        return {"id": doc["id"], "status": "received"}
