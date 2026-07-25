import asyncio
import ipaddress
import logging
import re
import socket
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


def _feed_title(xml_text: str) -> Optional[str]:
    try:
        root = ElementTree.fromstring(xml_text)
    except ElementTree.ParseError:
        return None
    if root.tag == "rss":
        channel = root.find("channel")
        return channel.findtext("title") if channel is not None else None
    if root.tag.endswith("feed"):
        ns = root.tag[: root.tag.index("}") + 1] if "}" in root.tag else ""
        return root.findtext(f"{ns}title")
    return None


_MAX_CUSTOM_FEED_REDIRECTS = 5


async def _reject_private_host(hostname: str) -> None:
    """Resolves the hostname and raises unless every resolved address is an ordinary public IP.
    A hostname-string blocklist alone (the previous approach) misses 172.16.0.0/12, most of
    127.0.0.0/8, IPv6 private/link-local/mapped ranges, and - the sharpest gap - DNS rebinding,
    since an attacker-controlled domain can simply resolve to whatever private IP they want.
    Uses the event loop's own resolver (not the blocking stdlib socket call directly) to match
    this module's async-everywhere convention."""
    try:
        loop = asyncio.get_running_loop()
        infos = await loop.getaddrinfo(hostname, None)
    except socket.gaierror:
        raise ValueError("That URL isn't reachable")
    if not infos:
        raise ValueError("That URL isn't reachable")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            raise ValueError("That URL isn't reachable")


async def fetch_custom_feed_name(feed_url: str) -> tuple[str, str]:
    """Validates a user-submitted feed URL with a live fetch and returns (name, resolved_url) -
    the channel/feed's own <title>, and the final URL after following any redirects (so the
    periodic re-fetch in _fetch_outlet, which deliberately does NOT follow redirects like the
    curated catalog's pre-resolved URLs, still works on subsequent fetches). Raises ValueError
    with a user-facing message on any failure - bad scheme, unreachable, not parseable RSS/Atom.

    Redirects are followed manually (httpx's follow_redirects=True was the SSRF hole here) so
    every hop - not just the first URL - gets the same public-IP check before being connected to;
    otherwise a public initial URL could 302 straight to an internal target with no recheck."""
    url = feed_url
    async with httpx.AsyncClient(follow_redirects=False) as client:
        for _ in range(_MAX_CUSTOM_FEED_REDIRECTS + 1):
            parsed = urlparse(url)
            if parsed.scheme not in ("http", "https"):
                raise ValueError("Feed URL must start with http:// or https://")
            if not parsed.hostname:
                raise ValueError("That URL isn't reachable")
            await _reject_private_host(parsed.hostname)

            try:
                resp = await client.get(
                    url, headers={"User-Agent": _FETCH_USER_AGENT}, timeout=_FETCH_TIMEOUT_SECONDS,
                )
            except Exception:
                raise ValueError("Could not reach that URL")

            if resp.is_redirect:
                location = resp.headers.get("location")
                if not location:
                    raise ValueError("Could not reach that URL")
                url = str(httpx.URL(url).join(location))
                continue

            try:
                resp.raise_for_status()
            except Exception:
                raise ValueError("Could not reach that URL")

            title = _feed_title(resp.text)
            if not title:
                raise ValueError("That doesn't look like an RSS or Atom feed")
            return title.strip(), str(resp.url)

    raise ValueError("Could not reach that URL")


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


def _custom_outlet(cf: dict) -> Outlet:
    return Outlet(id=cf["id"], name=cf["name"], description="Custom feed", feed_url=cf["feed_url"])


async def get_headlines_for_user(
    news_country: Optional[str],
    news_outlet_ids: list[str],
    custom_feeds: Optional[list[dict]] = None,
    limit: int = 3,
) -> list[NewsItem]:
    if not news_outlet_ids:
        return []

    # Resolved against every known outlet, not just news_country's list: outlet_ids can also
    # include topic-pool feeds followed via /dailybrew/search-feeds (e.g. "AI"), which aren't
    # scoped to any country, plus this user's own custom-added feeds. news_country only drives
    # the picker's default suggestions.
    outlets = [o for o in catalog.all_outlets() if o.id in news_outlet_ids]
    outlets += [_custom_outlet(cf) for cf in (custom_feeds or []) if cf["id"] in news_outlet_ids]
    if not outlets:
        return []

    # Preserve follow order (news_outlet_ids), not catalog/lookup order - the distribution below
    # treats "first followed" and "last followed" as meaningful, which needs this.
    follow_order = {oid: i for i, oid in enumerate(news_outlet_ids)}
    outlets.sort(key=lambda o: follow_order.get(o.id, len(follow_order)))
    # Only as many outlets as headline slots participate directly - matches the "follow at most
    # `limit`" cap the client enforces; a client that somehow has more selected just contributes
    # its first `limit` followed outlets.
    outlets = outlets[:limit]

    per_outlet_items = await asyncio.gather(*(_fetch_outlet(o) for o in outlets))
    for items in per_outlet_items:
        items.sort(key=_sort_key, reverse=True)

    # One followed outlet -> every slot from it. Two -> the first-followed one gets the extra
    # slot(s), so a lone second source doesn't crowd out the one the user prioritized. Three (or
    # more, capped above to `limit`) -> exactly one each, an even spread across every source.
    n = len(outlets)
    if n == 1:
        quotas = [limit]
    elif n == 2:
        quotas = [limit - limit // 2, limit // 2]  # limit=3 -> [2, 1]
    else:
        quotas = [1] * n
        for i in range(limit - n):  # only matters if limit > n, not the common case
            quotas[i % n] += 1

    picked: list[dict] = []
    leftover: list[dict] = []
    for items, quota in zip(per_outlet_items, quotas):
        picked.extend(items[:quota])
        leftover.extend(items[quota:])

    # Backfill: one followed outlet running short on fresh items shouldn't shrink the total below
    # `limit` when another followed outlet has more available - fill any remaining slots with the
    # next-freshest items from anywhere else, same ordering as the old single-pool behavior.
    if len(picked) < limit:
        leftover.sort(key=_sort_key, reverse=True)
        picked.extend(leftover[: limit - len(picked)])

    return [NewsItem(**item) for item in picked[:limit]]


def get_country_catalog(country: str) -> list[Outlet]:
    return catalog.OUTLET_CATALOG.get(country.upper(), [])


def find_outlets(ids: list[str], custom_feeds: Optional[list[dict]] = None) -> list[Outlet]:
    """Resolve specific outlet ids to their full display info - lets the client show what's
    already selected/followed (including a topic-pool feed followed via search, or this user's
    own custom-added feed - neither of which is in the current country list or search results)
    without a live search query."""
    custom_by_id = {cf["id"]: cf for cf in (custom_feeds or [])}
    found = []
    for oid in ids:
        outlet = catalog.find_outlet(oid)
        if outlet:
            found.append(outlet)
        elif oid in custom_by_id:
            found.append(_custom_outlet(custom_by_id[oid]))
    return found


def _words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", text.lower())


def search_feeds(query: str, limit: int = 5) -> list[Outlet]:
    """Case-insensitive match against every known outlet's name, description, and topic tags -
    searches both the per-country catalog and the topic-focused pool.

    Matches per-word, not just the whole phrase: a real query is usually 2-3 words (the picker's
    own placeholder suggests "AI news"/"global news"), and requiring the literal phrase to appear
    somewhere was too strict - "AI news" matched nothing even though "AI" plainly should, since no
    outlet's text happens to contain that exact two-word string.

    Matching is word-prefix, not raw substring ("movie" matches the word "movies", but a short
    query like "AI" only matches a whole/prefix word - not embedded mid-word, e.g. inside
    "entertainment". Plain substring matching was doing exactly that: "ai" is literally the 7th-8th
    characters of "entertainment", so every outlet tagged "Entertainment" was false-matching "AI").

    Each word is scored by the most specific field it matches (topic tag > name > free-text
    description), not just counted - otherwise a generic word like "news" matching some unrelated
    outlet's description would carry the same weight as a real topic-tag match."""
    q = query.strip().lower()
    if not q:
        return []

    words = [w for w in _words(q) if len(w) >= 2]
    if not words:
        return []

    scored: list[tuple[int, Outlet]] = []
    for outlet in catalog.all_outlets():
        name_words = _words(outlet.name)
        desc_words = _words(outlet.description)
        topic_words = [tw for t in outlet.topics for tw in _words(t)]

        score = 0
        for w in words:
            if any(tw.startswith(w) for tw in topic_words):
                score += 3
            elif any(nw.startswith(w) for nw in name_words):
                score += 2
            elif any(dw.startswith(w) for dw in desc_words):
                score += 1

        if score > 0:
            scored.append((score, outlet))

    scored.sort(key=lambda pair: pair[0], reverse=True)
    return [outlet for _, outlet in scored[:limit]]
