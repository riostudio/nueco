import asyncio
import logging
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Optional
from urllib.parse import urlparse
from xml.etree import ElementTree

import httpx

from . import catalog
from .catalog import Outlet
from .schemas import NewsItem

logger = logging.getLogger(__name__)

CACHE_TTL_SECONDS = 900  # 15 minutes - no RSS source is hit more often than this.

# A browser-like User-Agent - some outlets (e.g. Tribunnews) 403 a bare/unfamiliar UA string
# but accept this one, so it's less "identify ourselves" and more "get treated like a normal
# reader" for outlets that block unrecognized bots.
_FETCH_USER_AGENT = "Mozilla/5.0 (compatible; MemoPad/1.0; +https://memopad.app)"
_FETCH_TIMEOUT_SECONDS = 8

# In-memory per-outlet cache: outlet id -> {"items": [...], "fetched_at": epoch seconds}.
# Railway runs a single replica for this service today (see canva/service.py's identical
# note), so in-memory is fine - if that ever changes, move this to a short-TTL Mongo
# collection so every replica isn't refetching the same feeds independently.
_outlet_cache: dict[str, dict] = {}
_fetch_lock = asyncio.Lock()

def _sort_key(item: dict) -> float:
    """Epoch seconds for descending sort, with undated items sorting last. Normalizes to a
    float rather than comparing datetimes directly so a naive datetime (no tzinfo, which can
    happen with a malformed Atom timestamp) never blows up the comparison against an
    aware one."""
    dt = item["published_at"]
    if dt is None:
        return float("-inf")
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def _parse_rss_item(item: ElementTree.Element, source_name: str) -> Optional[dict]:
    title = item.findtext("title")
    link = item.findtext("link")
    if not title or not link:
        return None

    published_at = None
    pub_date = item.findtext("pubDate")
    if pub_date:
        try:
            published_at = parsedate_to_datetime(pub_date)
        except (TypeError, ValueError):
            published_at = None

    return {
        "headline": title.strip(),
        "link": link.strip(),
        "source_name": source_name,
        "published_at": published_at,
    }


def _parse_atom_entry(entry: ElementTree.Element, source_name: str, ns: str) -> Optional[dict]:
    title = entry.findtext(f"{ns}title")
    link_el = entry.find(f"{ns}link")
    link = link_el.get("href") if link_el is not None else None
    if not title or not link:
        return None

    published_at = None
    date_text = entry.findtext(f"{ns}published") or entry.findtext(f"{ns}updated")
    if date_text:
        try:
            published_at = datetime.fromisoformat(date_text.replace("Z", "+00:00"))
        except ValueError:
            published_at = None

    return {
        "headline": title.strip(),
        "link": link.strip(),
        "source_name": source_name,
        "published_at": published_at,
    }


def _parse_feed(xml_text: str, source_name: str) -> list[dict]:
    root = ElementTree.fromstring(xml_text)

    if root.tag == "rss":
        channel = root.find("channel")
        if channel is None:
            return []
        items = []
        for item_el in channel.findall("item"):
            parsed = _parse_rss_item(item_el, source_name)
            if parsed:
                items.append(parsed)
        return items

    if root.tag.endswith("feed"):
        # Atom - namespace-qualified tag names, e.g. "{http://www.w3.org/2005/Atom}feed".
        ns = root.tag[: root.tag.index("}") + 1] if "}" in root.tag else ""
        items = []
        for entry_el in root.findall(f"{ns}entry"):
            parsed = _parse_atom_entry(entry_el, source_name, ns)
            if parsed:
                items.append(parsed)
        return items

    return []


def _logo_url_for(outlet: Outlet) -> str:
    """A favicon-as-logo, derived from the feed's own domain rather than hand-curated per
    outlet - one fewer thing to keep in sync as outlets are added/changed in catalog.py."""
    domain = urlparse(outlet.feed_url).netloc
    return f"https://www.google.com/s2/favicons?sz=64&domain={domain}"


async def _fetch_outlet(outlet: Outlet) -> list[dict]:
    """Returns this outlet's items, from cache if fresh, else fetched fresh and cached.
    Best-effort: any network/parse failure falls back to the last-known-good cache (or an
    empty list if there's never been one) rather than raising - a slow/dead feed should never
    break the Daily Brew card."""
    cached = _outlet_cache.get(outlet.id)
    if cached and (time.time() - cached["fetched_at"]) < CACHE_TTL_SECONDS:
        return cached["items"]

    async with _fetch_lock:
        # Re-check after acquiring the lock - another concurrent request may have already
        # refreshed this outlet while we were waiting.
        cached = _outlet_cache.get(outlet.id)
        if cached and (time.time() - cached["fetched_at"]) < CACHE_TTL_SECONDS:
            return cached["items"]

        try:
            async with httpx.AsyncClient() as client:
                resp = await client.get(
                    outlet.feed_url,
                    headers={"User-Agent": _FETCH_USER_AGENT},
                    timeout=_FETCH_TIMEOUT_SECONDS,
                )
            resp.raise_for_status()
            items = _parse_feed(resp.text, outlet.name)
            logo_url = _logo_url_for(outlet)
            for item in items:
                item["logo_url"] = logo_url
            _outlet_cache[outlet.id] = {"items": items, "fetched_at": time.time()}
            return items
        except Exception as e:
            logger.error(f"Daily Brew: failed to fetch/parse {outlet.id} ({outlet.feed_url}): {e}")
            if cached:
                return cached["items"]
            return []


async def prewarm_all_outlets() -> None:
    await asyncio.gather(*(_fetch_outlet(o) for o in catalog.all_outlets()), return_exceptions=True)


async def run_cache_prewarmer() -> None:
    """Keeps every curated outlet's cache warm in the background so a user-facing /dailybrew/news
    request only ever reads from cache instead of paying the cold multi-second RSS-fetch cost.
    Runs more often than CACHE_TTL_SECONDS so the cache never actually goes stale between cycles.
    Started once from server.py's startup event; intentionally never awaited/joined - it's meant
    to run for the life of the process."""
    while True:
        try:
            await prewarm_all_outlets()
        except Exception as e:
            logger.error(f"Daily Brew cache prewarm cycle failed: {e}")
        await asyncio.sleep(600)


async def get_headlines_for_user(
    news_country: Optional[str],
    news_outlet_ids: list[str],
    limit: int = 5,
) -> list[NewsItem]:
    if not news_outlet_ids:
        return []

    # Resolved against every known outlet, not just news_country's list: outlet_ids can also
    # include topic-pool feeds followed via /dailybrew/search-feeds (e.g. "AI"), which aren't
    # scoped to any country. news_country only drives the picker's default suggestions.
    outlets = [o for o in catalog.all_outlets() if o.id in news_outlet_ids]
    if not outlets:
        return []

    results = await asyncio.gather(*(_fetch_outlet(o) for o in outlets))
    flattened: list[dict] = [item for outlet_items in results for item in outlet_items]
    flattened.sort(key=_sort_key, reverse=True)

    return [NewsItem(**item) for item in flattened[:limit]]


def get_country_catalog(country: str) -> list[Outlet]:
    return catalog.OUTLET_CATALOG.get(country.upper(), [])


def search_feeds(query: str, limit: int = 5) -> list[Outlet]:
    """Case-insensitive substring match against every known outlet's name, description, and
    topic tags - searches both the per-country catalog and the topic-focused pool, so e.g.
    typing "AI" surfaces TechCrunch AI even though it's not tied to a country."""
    q = query.strip().lower()
    if not q:
        return []

    matches = []
    for outlet in catalog.all_outlets():
        haystack = [outlet.name.lower(), outlet.description.lower()] + [t.lower() for t in outlet.topics]
        if any(q in field for field in haystack):
            matches.append(outlet)
        if len(matches) >= limit:
            break
    return matches
