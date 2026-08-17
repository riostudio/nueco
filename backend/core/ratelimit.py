"""Sliding-window rate limiting for the AI endpoints.

WHY THESE ENDPOINTS SPECIFICALLY
Transcription and text processing are the only routes that spend money per call, and they spend
it against an OpenAI key that lives on THIS SERVER. That key's quota is shared by every user, so
an unthrottled client stuck in a retry loop does not exhaust its own allowance - it exhausts
everyone's, and the failure surfaces as "transcription failed" for people who did nothing wrong.
Client-side throttling cannot cover this: a modified or simply buggy build ignores it.

Framework-agnostic on purpose (no fastapi import) so it obeys the same layering rule as the
service modules - routers translate a RateLimited result into an HTTP 429.

SHARED STATE
When REDIS_URL is set, quota state lives in Redis (sorted-set sliding windows), so every instance
counts against the same window and a load balancer cannot multiply the effective limit. When it
is unset or unreachable, the limiter falls back to in-process state: correct for a single
instance, and with N replicas the effective limit is N x the configured value - degraded
protection rather than no protection.
"""
import logging
import os
import threading
import time
import uuid
from collections import defaultdict, deque
from dataclasses import dataclass
from typing import Deque, Dict, Optional, Tuple

logger = logging.getLogger(__name__)


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

# ---- Shared (cross-instance) state via Redis --------------------------------
# Sorted-set sliding window per key: members are timestamps, expired entries are pruned on every
# check. REDIS_URL unset (today's single-instance deployment) -> None -> in-process fallback.

_redis_client = None
_redis_init_lock = threading.Lock()
_REDIS_KEY_PREFIX = "nueco:rl:"


def _get_redis_client():
    """Lazily-created shared Redis client, or None when REDIS_URL is unset/unreachable."""
    global _redis_client
    if _redis_client is not None:
        return _redis_client
    url = os.environ.get("REDIS_URL", "").strip()
    if not url:
        return None
    with _redis_init_lock:
        if _redis_client is None:
            try:
                import redis  # imported lazily so the in-process path never needs the dependency
                client = redis.Redis.from_url(url, socket_connect_timeout=1, socket_timeout=1)
                client.ping()
                _redis_client = client
            except Exception as e:
                logger.warning(
                    "Redis rate-limit backend unavailable, using in-process limits: %s", type(e).__name__
                )
    return _redis_client


def _retry_after_from(oldest_ms: Optional[float], quota: Quota, now_ms: int) -> int:
    if oldest_ms is None:
        return 1
    # Retry when the OLDEST call in the window ages out - the earliest moment a slot frees.
    return max(1, int((oldest_ms + quota.window_seconds * 1000 - now_ms) / 1000) + 1)


def _redis_window_count(client, key: str, quota: Quota, now_ms: int) -> Tuple[int, Optional[float]]:
    window_start = now_ms - quota.window_seconds * 1000
    pipe = client.pipeline()
    pipe.zremrangebyscore(key, 0, window_start)
    pipe.zcard(key)
    _, count = pipe.execute()
    oldest = None
    if count >= quota.limit:
        oldest_entries = client.zrange(key, 0, 0, withscores=True)
        if oldest_entries:
            oldest = oldest_entries[0][1]
    return count, oldest


def _check_shared(
    key: str,
    quota: Quota,
    global_key: Optional[str],
    global_quota: Optional[Quota],
) -> Optional[RateLimitDecision]:
    """Shared-window check. Returns None when Redis is unavailable, meaning the caller must fall
    back to the in-process limiter. Same consume-on-allow / consume-nothing-on-deny semantics as
    SlidingWindowLimiter.check."""
    client = _get_redis_client()
    if client is None:
        return None
    try:
        now_ms = int(time.time() * 1000)
        count, oldest = _redis_window_count(client, key, quota, now_ms)
        if count >= quota.limit:
            return RateLimitDecision(False, _retry_after_from(oldest, quota, now_ms), "user")
        if global_key and global_quota:
            g_count, g_oldest = _redis_window_count(client, global_key, global_quota, now_ms)
            if g_count >= global_quota.limit:
                return RateLimitDecision(False, _retry_after_from(g_oldest, global_quota, now_ms), "global")
        member = f"{now_ms}:{uuid.uuid4().hex[:8]}"
        pipe = client.pipeline()
        pipe.zadd(key, {member: now_ms})
        pipe.pexpire(key, quota.window_seconds * 1000)
        if global_key and global_quota:
            pipe.zadd(global_key, {member: now_ms})
            pipe.pexpire(global_key, global_quota.window_seconds * 1000)
        pipe.execute()
        return RateLimitDecision(True)
    except Exception as e:
        logger.warning("Redis rate-limit check failed, falling back to in-process: %s", type(e).__name__)
        return None


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
    transcription ceiling can still, say, organise text they already have. Prefers the shared
    Redis windows (correct across instances); falls back to in-process state when Redis is
    absent, which degrades but never removes the protection."""
    key = f"{endpoint}:{user_id}"
    shared = _check_shared(
        _REDIS_KEY_PREFIX + key, quota, _REDIS_KEY_PREFIX + GLOBAL_AI_KEY, GLOBAL_AI_QUOTA
    )
    if shared is not None:
        return shared
    return ai_limiter.check(
        key=key,
        quota=quota,
        global_key=GLOBAL_AI_KEY,
        global_quota=GLOBAL_AI_QUOTA,
    )
