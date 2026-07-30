"""Reusable SSRF (server-side request forgery) protection for fetching a user-influenced URL.

Extracted out of dailybrew/service.py, where this was originally solved once, locally, for
custom RSS feed URLs - the guard logic itself has nothing to do with RSS/feeds and is worth
generalizing to any future feature that needs to safely fetch a URL a user supplied (the
frontend's `share/unfurl.ts` does the structurally identical thing today with no equivalent
guard - see business_logic_map.md's SSRF invariant note and architectural_audit.md §1.6/§4
Phase 6; that frontend gap is a tracked follow-up, not fixed here, since it needs its own
network-layer solution on that side of the stack).

Two things make a plain hostname-string blocklist insufficient, both handled here:
  1. Private/internal IP RANGES (172.16.0.0/12, most of 127.0.0.0/8, IPv6 private/link-local/
     mapped ranges) are numerous and easy to miss enumerating by hand.
  2. DNS rebinding: an attacker-controlled domain can resolve to whatever IP they want, so the
     hostname string alone tells you nothing - only resolving it and checking the actual
     resulting IP(s) closes this gap.

`safe_get` additionally re-validates on EVERY redirect hop, not just the initial URL - an
httpx call with `follow_redirects=True` would otherwise let a public initial URL 302 straight
to an internal target with no recheck.
"""
import asyncio
import ipaddress
import socket
from urllib.parse import urlparse

import httpx

_FETCH_USER_AGENT = "Mozilla/5.0 (compatible; Nueco/1.0; +https://nueco.app)"
_DEFAULT_MAX_REDIRECTS = 5


class SsrfGuardError(Exception):
    """Base class for every rejection this module raises."""


class InvalidSchemeError(SsrfGuardError):
    """URL scheme isn't http/https."""


class UnreachableHostError(SsrfGuardError):
    """Hostname is missing, doesn't resolve, or resolves to a private/internal address."""


class FetchFailedError(SsrfGuardError):
    """The request itself failed: network error, non-2xx status, a redirect with no Location
    header, or more redirect hops than the caller allowed."""


async def reject_private_host(hostname: str) -> None:
    """Resolves `hostname` and raises UnreachableHostError unless every resolved address is an
    ordinary public IP. Uses the event loop's own resolver (not the blocking stdlib socket call
    directly) to stay async-safe under a single-threaded event loop."""
    try:
        loop = asyncio.get_running_loop()
        infos = await loop.getaddrinfo(hostname, None)
    except socket.gaierror:
        raise UnreachableHostError(hostname)
    if not infos:
        raise UnreachableHostError(hostname)
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            raise UnreachableHostError(hostname)


async def safe_get(
    url: str,
    *,
    headers: dict | None = None,
    timeout: float = 8.0,
    max_redirects: int = _DEFAULT_MAX_REDIRECTS,
) -> httpx.Response:
    """GETs `url`, following redirects manually so every hop - not just the first URL - gets
    the same scheme + public-IP check before being connected to. Returns the final response on
    success. Raises InvalidSchemeError / UnreachableHostError / FetchFailedError on any failure,
    with no partial/leaked response object."""
    request_headers = {"User-Agent": _FETCH_USER_AGENT, **(headers or {})}
    current = url
    async with httpx.AsyncClient(follow_redirects=False) as client:
        for _ in range(max_redirects + 1):
            parsed = urlparse(current)
            if parsed.scheme not in ("http", "https"):
                raise InvalidSchemeError(current)
            if not parsed.hostname:
                raise UnreachableHostError(current)
            await reject_private_host(parsed.hostname)

            try:
                resp = await client.get(current, headers=request_headers, timeout=timeout)
            except Exception as e:
                raise FetchFailedError(str(e))

            if resp.is_redirect:
                location = resp.headers.get("location")
                if not location:
                    raise FetchFailedError("redirect with no Location header")
                current = str(httpx.URL(current).join(location))
                continue

            try:
                resp.raise_for_status()
            except Exception as e:
                raise FetchFailedError(str(e))

            return resp

    raise FetchFailedError("too many redirects")
