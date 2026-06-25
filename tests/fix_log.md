# Agent 7 — Fix Log

**Mode chosen by operator: REPORT-FIRST (no autonomous commit loop).**
**Target chosen by operator: LOCAL-ISOLATED (in-memory Mongo, in-process ASGI; Atlas & Railway untouched).**

The autonomous 5-iteration auto-commit fix loop was **not** run. Per the operator's
selection, the suite produced findings + reports for review, and fixes will be applied
on a `fix/auto-repair` branch *with* review rather than auto-committed.

---

## Iteration 0 — harness construction & calibration — 2026-06-23

### Test-harness corrections (NOT application changes)
Two assertions initially mis-fired against correct app behaviour and were fixed in
`tests/simulate_users.py` so the report reflects reality:

- **`first_note_<=3_interactions`**: was counting *total* interactions across all of a
  new user's notes instead of interactions-to-first-note. Fixed to capture the count at
  the moment the first note is saved. App behaviour was already correct.
- **`AUTH-06` (brute force)**: verifier issued a 7th login that was rate-limited (429) and
  then asserted on a "locked" message it never received. Rewritten to treat **either**
  account lockout **or** a 429 as valid protection (matches the benchmark wording). App
  protection was already working (lockout + per-email/IP rate limiting).

### Outbound-safety fix (harness, security-relevant)
- Discovered that `backend/server.py` runs `load_dotenv(backend/.env)` at import, which
  pulled the **real Resend API key** into the env and caused one real verification email
  to be sent during an early smoke test. Hardened `tests/harness.py` to pre-empty
  `SMTP_PASS`/AWS keys before import and to hard-stub the `requests` module, so no outbound
  HTTP can leave the process. One real email attempt occurred before this fix (disclosed).

### Result
- Persona behavioural checks: **all pass**.
- Security controls: **18 PASS, 2 FAIL (medium), 1 N/A**.
- pytest: **35 passed, 2 xfailed** (the two documented gaps).

---

## Iteration 1 — apply approved fixes — 2026-06-23 (branch `fix/auto-repair`)

### Failures identified
- [medium][Session] AUTH-08 — access token (JWT) not revoked on logout.
- [medium][Input Validation] INP-03 — no server-side max payload size (>1MB accepted).

### Fixes applied
- File: `backend/auth/service.py`
  Change: bind each access token to its login session via a `sid` claim
  (`_create_access_token(user_id, session_id)`), set it in `login` and `refresh`,
  and enforce it in `verify_access_token` (reject if the session was deleted/expired).
  Logout already deletes the session, so the access token is now revoked server-side.
  Benchmark targeted: AUTH-08 (Logout invalidates token → reuse 401).
- File: `backend/server.py`
  Change: add `_validate_note_payload()` with caps (content 256KB, title 1000 chars,
  images 8MB total) and call it in `create_note` and `update_note` → HTTP 413.
  Benchmark targeted: INP-03 (Oversized payload rejected).

Files changed this iteration: **2** (within the ≤3-file limit).

### Re-test result
- **PASS** — Security FAIL findings: 0. Persona check failures: 0. pytest: 39 passed.
- Remaining failures: none. (Two eval tests flipped from xfail → pass.)

### Deployment notes (read before shipping)
- AUTH-08 is **not backward-compatible with already-issued tokens**: existing access
  tokens lack `sid` and will be rejected after deploy → all users do a one-time re-login.
  (Refresh tokens still work, so clients holding a refresh token re-auth transparently.)
- Each authenticated request now does one extra `sessions.find_one({id: sid})` read.
  An index on `sessions.id` already exists (created at startup), so this is a point lookup.
- Access-token lifetime (24h) < session lifetime (30d), so the session always outlives
  the token; binding never causes premature expiry.
