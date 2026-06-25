#!/usr/bin/env python3
"""
Agent 4 — Staging latency & transport runner (REAL network).

Unlike simulate_users.py (in-memory, in-process), this hits a real deployment to
capture latency, cold-start, and transport/security-header behaviour that can only
be observed over the wire.

USAGE
  export MEMOPAD_API_URL="https://<your-staging-host>"      # required, must be https
  # optional: authenticated-endpoint latency needs a PRE-VERIFIED account
  export MEMOPAD_TEST_EMAIL="someone@example.com"
  export MEMOPAD_TEST_PASSWORD="..."
  python tests/run_staging.py

SAFETY
  - Refuses to run if MEMOPAD_API_URL is unset or not https://.
  - Refuses the known PRODUCTION host unless MEMOPAD_ALLOW_PROD=1 (avoid hammering prod).
  - Warms up sequentially, adds jitter, and trips a circuit breaker on repeated 429/503.
  - Any notes it creates for latency sampling are deleted again at the end.
Outputs: tests/report_staging.md
"""
import asyncio
import os
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent

KNOWN_PROD_HOST = "web-production-a3258.up.railway.app"
WARMUP_REQUESTS = 5
LATENCY_SAMPLES = 20
CB_MAX_THROTTLE = 5         # circuit breaker: abort after this many 429/503 in a row

# capture-speed benchmarks (ms)
BENCH = {
    "POST /notes (save)": ("post", 500),
    "GET /notes (retrieve)": ("get", 800),
    "PUT+GET /notes (edit round-trip)": ("edit", 1000),
    "GET /health (cold start)": ("cold", 2000),
}


def _fail(msg: str, code: int = 2):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def _resolve_target() -> str:
    base = (os.getenv("MEMOPAD_API_URL") or "").strip().rstrip("/")
    if not base:
        _fail("MEMOPAD_API_URL is not set. Point it at a STAGING https URL and re-run.")
    if not base.startswith("https://"):
        _fail(f"MEMOPAD_API_URL must be https:// (got {base!r}).")
    if KNOWN_PROD_HOST in base and os.getenv("MEMOPAD_ALLOW_PROD") != "1":
        _fail(f"Refusing to target the production host {KNOWN_PROD_HOST}. "
              "Use a staging URL, or set MEMOPAD_ALLOW_PROD=1 to override (not recommended).")
    return base


class CircuitBreaker:
    def __init__(self):
        self.throttle_streak = 0

    def record(self, status: int):
        if status in (429, 503):
            self.throttle_streak += 1
            if self.throttle_streak >= CB_MAX_THROTTLE:
                _fail(f"Circuit breaker tripped: {CB_MAX_THROTTLE} consecutive 429/503 "
                      "responses. Backing off to protect the deployment.", code=3)
        else:
            self.throttle_streak = 0


def pct(values, p):
    if not values:
        return None
    return round(statistics.quantiles(values, n=100)[p - 1], 2) if len(values) > 1 else round(values[0], 2)


async def timed(client, cb, method, url, **kw):
    import httpx
    await asyncio.sleep(0.05)  # gentle jitter / pacing
    t0 = time.perf_counter()
    try:
        r = await client.request(method, url, **kw)
    except httpx.HTTPError as e:
        return None, str(e)
    dt = (time.perf_counter() - t0) * 1000.0
    cb.record(r.status_code)
    if r.status_code in (429, 503):
        await asyncio.sleep(1.0 + cb.throttle_streak)  # exponential-ish backoff
    return r, dt


async def transport_checks(client, base, cb, report):
    import httpx
    report.append("## Transport & security headers\n")
    # 1. server header leak
    r, _ = await timed(client, cb, "GET", "/api/health")
    server_hdr = r.headers.get("server", "") if r else "(no response)"
    leak = "uvicorn" in server_hdr.lower() or "gunicorn" in server_hdr.lower()
    report.append(f"- **Server header:** `{server_hdr!r}` — "
                  f"{'⚠️ leaks server software' if leak else 'ok / generic'}")

    # 2. HTTPS enforcement: try the http:// variant
    http_url = base.replace("https://", "http://", 1) + "/api/health"
    https_enforced = None
    async with httpx.AsyncClient(timeout=15.0, follow_redirects=False) as plain:
        try:
            rr = await plain.get(http_url)
            if rr.status_code in (301, 302, 307, 308) and rr.headers.get("location", "").startswith("https://"):
                https_enforced = f"redirects to https ({rr.status_code})"
            elif rr.status_code >= 400:
                https_enforced = f"http rejected ({rr.status_code})"
            else:
                https_enforced = f"⚠️ http served directly ({rr.status_code}) — no redirect"
        except httpx.HTTPError:
            https_enforced = "http connection refused (https-only)"
    report.append(f"- **HTTPS enforcement:** {https_enforced}")

    # 3. HSTS header
    hsts = r.headers.get("strict-transport-security") if r else None
    report.append(f"- **HSTS:** {('present: ' + hsts) if hsts else '⚠️ no Strict-Transport-Security header'}")

    # 4. CORS preflight
    try:
        pre = await client.request("OPTIONS", "/api/notes", headers={
            "Origin": "https://evil.example",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization",
        })
        acao = pre.headers.get("access-control-allow-origin")
        if acao == "*":
            cors = "⚠️ Access-Control-Allow-Origin: * (open CORS)"
        elif acao:
            cors = f"restricted: {acao}"
        else:
            cors = "no CORS headers returned for cross-origin preflight"
        report.append(f"- **CORS (untrusted origin):** {cors}")
    except Exception as e:  # noqa: BLE001
        report.append(f"- **CORS:** could not evaluate ({e})")
    report.append("")


async def latency_pass(client, base, cb, report):
    report.insert(0, "")  # spacer
    # ---- cold start + warm health ----
    health = []
    for i in range(WARMUP_REQUESTS):
        r, dt = await timed(client, cb, "GET", "/api/health")
        if isinstance(dt, float):
            health.append(dt)
    cold = health[0] if health else None
    warm_median = round(statistics.median(health[1:]), 2) if len(health) > 1 else None

    results = {"cold": [cold] if cold else [], "post": [], "get": [], "edit": []}

    # ---- authenticated latency (optional) ----
    email = os.getenv("MEMOPAD_TEST_EMAIL")
    password = os.getenv("MEMOPAD_TEST_PASSWORD")
    authed_note = []
    headers = None
    if email and password:
        r, dt = await timed(client, cb, "POST", "/api/auth/login",
                            json={"email": email, "password": password,
                                  "device_name": "staging-bench", "platform": "test"})
        if r is not None and r.status_code == 200:
            headers = {"Authorization": f"Bearer {r.json()['access_token']}"}
        else:
            report.append(f"> ⚠️ Login failed ({r.status_code if r else 'no response'}); "
                          "skipping authenticated latency. Provide a PRE-VERIFIED account.\n")

    if headers:
        created = []
        for i in range(LATENCY_SAMPLES):
            r, dt = await timed(client, cb, "POST", "/api/notes",
                                json={"title": f"bench {i}", "content": "latency probe"}, headers=headers)
            if r is not None and r.status_code == 200:
                results["post"].append(dt)
                nid = r.json()["id"]
                created.append(nid)
                r2, dt2 = await timed(client, cb, "GET", "/api/notes", headers=headers)
                if isinstance(dt2, float):
                    results["get"].append(dt2)
                # edit round-trip = PUT + confirming GET
                t0 = time.perf_counter()
                await timed(client, cb, "PUT", f"/api/notes/{nid}",
                            json={"content": "edited"}, headers=headers)
                await timed(client, cb, "GET", f"/api/notes/{nid}", headers=headers)
                results["edit"].append((time.perf_counter() - t0) * 1000.0)
        # cleanup
        for nid in created:
            await timed(client, cb, "DELETE", f"/api/notes/{nid}", headers=headers)
        report.append(f"> Authenticated latency sampled over {len(created)} notes "
                      "(all created notes deleted afterwards).\n")
    else:
        report.append("> No MEMOPAD_TEST_EMAIL/PASSWORD set — only unauthenticated "
                      "(health) latency measured. Set a pre-verified account for note CRUD latency.\n")

    # ---- benchmark table ----
    report.append("## Capture-speed benchmarks (real network)\n")
    report.append(f"- Cold start (first /health): **{cold} ms**"
                  + (f" · warm median: {warm_median} ms" if warm_median else ""))
    report.append("")
    report.append("| Benchmark | Target | p50 | p95 | Verdict |")
    report.append("|---|---|---|---|---|")
    for label, (key, target) in BENCH.items():
        vals = results.get(key, [])
        if not vals:
            report.append(f"| {label} | <{target}ms | — | — | _not measured_ |")
            continue
        p50 = round(statistics.median(vals), 2)
        p95 = pct(vals, 95)
        verdict = "✅ PASS" if (p95 or p50) <= target else "❌ FAIL"
        report.append(f"| {label} | <{target}ms | {p50} | {p95} | {verdict} |")
    report.append("")


async def main():
    import httpx
    base = _resolve_target()
    print(f"Target: {base}")
    report = [
        "# MemoPad — Staging Latency & Transport Report",
        "",
        f"_Generated: {datetime.now(timezone.utc).isoformat()}_",
        f"_Target: `{base}` (real network)_",
        "",
    ]
    cb = CircuitBreaker()
    async with httpx.AsyncClient(base_url=base, timeout=30.0, follow_redirects=True) as client:
        # quick reachability check
        r, dt = await timed(client, cb, "GET", "/api/health")
        if r is None or r.status_code != 200:
            _fail(f"Health check failed at {base}/api/health "
                  f"({r.status_code if r else dt}). Is the URL correct and the service up?")
        await latency_pass(client, base, cb, report)
        await transport_checks(client, base, cb, report)

    out = HERE / "report_staging.md"
    out.write_text("\n".join(report))
    print(f"Wrote {out}")


if __name__ == "__main__":
    asyncio.run(main())
