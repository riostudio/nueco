# MemoPad — Security Evaluation Report

_Generated: 2026-06-23T09:16:44.545274+00:00_
_Mode: **local-isolated (in-memory mongomock, in-process ASGI)**_

Synthetic flagged payloads only (`SQLI_TEST_PAYLOAD`, `XSS_TEST_PAYLOAD`, …) — no real attack strings, no real credentials/tokens logged.

## Summary

**20 PASS · 0 FAIL · 0 INFO · 1 N/A**

| ID | Sev | Status | Category | Expectation | Observed |
|---|---|---|---|---|---|
| TRANS-02 | info | **NA** | Transport | HTTPS enforced end-to-end | N/A in local-isolated mode |
| AUTHZ-01 | critical | **PASS** | Authorisation | User B cannot read User A's note | status=404 |
| AUTHZ-02 | critical | **PASS** | Authorisation | User B cannot edit User A's note | status=404 |
| AUTHZ-03 | critical | **PASS** | Authorisation | User B cannot delete User A's note | status=404 |
| AUTHZ-04 | critical | **PASS** | Data Isolation | A's note unchanged after B's attempts | content='owned by A' |
| PRIV-01 | high | **PASS** | Data Privacy | Password never returned by /auth/me | password in body=False |
| AUTH-01 | high | **PASS** | Authentication | missing token -> 401 | status=401 |
| AUTH-02 | high | **PASS** | Authentication | malformed token -> 401 | status=401 |
| AUTH-03 | high | **PASS** | Authentication | expired token -> 401 | status=401 |
| AUTH-04 | high | **PASS** | Authentication | wrong-secret token -> 401 | status=401 |
| AUTH-05 | high | **PASS** | Authentication | refresh token used as access -> 401 | status=401 |
| AUTH-06 | high | **PASS** | Brute Force | 5 failed logins trigger lockout or 429 | statuses=[401, 401, 401, 401, 429, 429] account_locked=False rate_limited_429=True |
| AUTH-07 | high | **PASS** | Session | Refresh token rejected after logout | refresh status=401 |
| INP-01 | medium | **PASS** | Input Validation | Malformed JSON -> 422 (never 500) | status=422 |
| INP-02 | medium | **PASS** | Input Validation | Bogus/invalid note id -> 4xx (not 500) | status=404 |
| INP-03 | medium | **PASS** | Input Validation | Oversized note (>1MB) rejected (413/400) | status=413 |
| AUTH-09 | medium | **PASS** | Password Policy | Password < 8 chars rejected at signup | status=400 |
| AUTH-08 | medium | **PASS** | Session | Access token revoked on logout (reuse -> 401) | reuse status=401 |
| INP-04 | low | **PASS** | Input Validation | Null/control bytes handled without crash | status=200 |
| TRANS-01 | low | **PASS** | Transport | No verbose Server version header | server='' |
| SEC-01 | info | **PASS** | Secrets | JWT_SECRET sourced from env, raises if missing | service.py raises ValueError when unset |

## Findings requiring action

_No FAIL-level findings._
## Notable PASS / hardening already present
- Strict per-user `user_id` scoping on every note/event query (read/update/delete).
- Cross-user access returns 404 (hides existence) — stronger than a bare 403.
- `user_id` cannot be spoofed via request body (server derives it from the JWT `sub`).
- Search is `re.escape`d → NoSQL/regex injection in search is neutralised.
- Passwords never appear in any response model; `/auth/me` returns no hash.
- JWT secret is env-sourced and the service refuses to start if it is unset.
- Brute force: account lockout (5 fails → 30 min) **and** per-email/IP 429 rate limiting.
- Password policy (≥8 chars) enforced at signup; weak passwords rejected (400).
- Email-verification gate before login; `.test`/reserved-TLD emails rejected by validator.

## Not validated in local-isolated mode (verify on Railway)
- HTTPS/HSTS enforcement, CORS origin restriction in production, `Server` header stripping.
- These need the live deployment; run the suite against staging to confirm.