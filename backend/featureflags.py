import asyncio
import logging
import os

import httpx

logger = logging.getLogger(__name__)

POSTHOG_HOST = os.getenv("POSTHOG_HOST", "https://us.i.posthog.com")
POSTHOG_PROJECT_API_KEY = os.getenv("POSTHOG_PROJECT_API_KEY")

REFRESH_INTERVAL_SECONDS = 60

# Resolved server-side instead of per-device: a client checking PostHog directly fails closed
# (hides the feature) if that device can't reach PostHog at all - ad-blockers, private DNS, and
# VPNs routinely block analytics domains. The server has one reliable network path shared by every
# user, so once this resolves for anyone it's correct for everyone, and /auth/me just hands the
# already-resolved value to the client as a normal user field.
_flags_cache: dict[str, bool] = {}


async def _refresh_flags() -> None:
    if not POSTHOG_PROJECT_API_KEY:
        return
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            f"{POSTHOG_HOST}/decide/?v=3",
            json={"api_key": POSTHOG_PROJECT_API_KEY, "distinct_id": "nueco-backend"},
        )
        resp.raise_for_status()
        flags = resp.json().get("featureFlags", {})
        _flags_cache["daily-brew-enabled"] = bool(flags.get("daily-brew-enabled", False))


async def run_flag_refresher() -> None:
    """Started once from server.py's startup event; intentionally never awaited/joined - it's
    meant to run for the life of the process. Mirrors dailybrew's run_cache_prewarmer."""
    while True:
        try:
            await _refresh_flags()
        except Exception as e:
            logger.error(f"Feature flag refresh failed: {e}")
        await asyncio.sleep(REFRESH_INTERVAL_SECONDS)


def is_daily_brew_enabled() -> bool:
    # Fail-closed until the first refresh lands, same as before - but now that's one server-side
    # network call at process startup, not every individual device's own reachability to PostHog.
    return _flags_cache.get("daily-brew-enabled", False)
