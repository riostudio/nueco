"""Sliding-window rate limiting for the AI endpoints.

WHY THESE ENDPOINTS SPECIFICALLY
Transcription and text processing are the only routes that spend money per call, and they spend
it against an OpenAI key that lives on THIS SERVER. That key's quota is shared by every user, so
an unthrottled client stuck in a retry loop does not exhaust its own allowance - it exhausts
everyone's, and the failure surfaces as "transcription failed" for people who did nothing wrong.
Client-side throttling cannot cover this: a modified or simply buggy build ignores it.

Framework-agnostic on purpose (no fastapi import) so it obeys the same layering rule as the
service modules - routers translate a RateLimited result into an HTTP 429.

KNOWN LIMITATION: state is in-process. It resets on deploy and is not shared across instances, so
with N replicas the effective limit is N x the configured value. That is acceptable for a
single-instance deployment and is the same tradeoff auth/router.py's existing limiter already
makes; moving to Redis is the fix if this ever scales horizontally.
"""
import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from typing import Deque, Dict, Optional, Tuple


@dataclass(frozen=True)
class Quota:
    """`limit` calls allowed per `window_seconds`, sliding."""
    limit: int
    window_seconds: int


@dataclass(frozen=True)
class RateLimitDecision:
    allowed: bool
    # Seconds until the caller may retry. Sent straight back as the Retry-After header, which the
    # client reads to pause outgoing requests instead of hammering a server already shedding load.
    retry_after: int = 0
    scope: str = ""


class SlidingWindowLimiter:
    """Per-key sliding window, plus an optional global window shared by every key.

    A per-user limit alone does not protect the shared OpenAI quota: a hundred users each staying
    politely under their own limit can still overrun it together. The global window is the backstop
    for exactly that.
    """

    def __init__(self) -> None:
        self._events: Dict[str, Deque[float]] = defaultdict(deque)
        # A single mutex rather than one per key: contention here is trivial next to the network
        # call these limits guard, and per-key locks would need their own eviction.
        self._lock = threading.Lock()

    def _check(self, key: str, quota: Quota, now: float) -> Tuple[bool, int]:
        window_start = now - quota.window_seconds
        events = self._events[key]
        while events and events[0] <= window_start:
            events.popleft()
        if len(events) >= quota.limit:
            # Retry when the OLDEST call in the window ages out - the earliest moment a slot frees.
            retry_after = max(1, int(events[0] + quota.window_seconds - now) + 1)
            return False, retry_after
        return True, 0

    def check(
        self,
        key: str,
        quota: Quota,
        global_key: Optional[str] = None,
        global_quota: Optional[Quota] = None,
    ) -> RateLimitDecision:
        """Consume one slot if both windows allow it. Nothing is consumed when denied, so a
        rejected caller is not pushed further from getting through by retrying."""
        now = time.monotonic()
        with self._lock:
            ok, retry = self._check(key, quota, now)
            if not ok:
                return RateLimitDecision(False, retry, "user")

            if global_key and global_quota:
                ok_g, retry_g = self._check(global_key, global_quota, now)
                if not ok_g:
                    return RateLimitDecision(False, retry_g, "global")
                self._events[global_key].append(now)

            self._events[key].append(now)
            return RateLimitDecision(True)

    def reset(self) -> None:
        """Test hook."""
        with self._lock:
            self._events.clear()


ai_limiter = SlidingWindowLimiter()

# Per-user quotas. Sized to be invisible to real use and obvious to a runaway loop.
#
# TRANSCRIPTION is the most expensive call and is bounded by human speech - recording, stopping and
# re-recording ten times inside a minute is already frantic.
TRANSCRIBE_QUOTA = Quota(limit=10, window_seconds=60)
# VOICE INTENT fires automatically after EVERY transcription, so its ceiling must sit above
# transcription's or it would reject work the user never explicitly asked for.
VOICE_INTENT_QUOTA = Quota(limit=20, window_seconds=60)
# TEXT PROCESSING is user-initiated per note (organise / summarise / smart format).
TEXT_PROCESS_QUOTA = Quota(limit=15, window_seconds=60)
# ARTIFACT EXTRACTION fires automatically after note captures (A4), same posture as voice intent:
# the ceiling must sit above transcription's or it rejects work the user never explicitly asked for.
EXTRACTION_QUOTA = Quota(limit=20, window_seconds=60)

# Shared-quota backstop across all users, protecting the single OpenAI key. Deliberately generous:
# it should never fire in normal operation, only blunt a genuine stampede.
GLOBAL_AI_QUOTA = Quota(limit=120, window_seconds=60)
GLOBAL_AI_KEY = "global:ai"


def check_ai_quota(user_id: str, endpoint: str, quota: Quota) -> RateLimitDecision:
    """Per-user AND global check for one AI endpoint. Keyed per endpoint so a user hitting their
    transcription ceiling can still, say, organise text they already have."""
    return ai_limiter.check(
        key=f"{endpoint}:{user_id}",
        quota=quota,
        global_key=GLOBAL_AI_KEY,
        global_quota=GLOBAL_AI_QUOTA,
    )
