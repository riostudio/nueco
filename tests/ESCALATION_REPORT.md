# Escalation Report — Issues for Human Review

> **UPDATE 2026-06-23:** Both findings below were **fixed** on branch `fix/auto-repair`
> (see `fix_log.md` Iteration 1). The suite is now green (0 security FAILs, 39 passed).
> The only remaining open items are the "verify on the live deployment" checks at the
> bottom — now wired up via `tests/run_staging.py` (run against a staging URL).

Generated from the local-isolated simulation (2026-06-23). Two genuine application
findings were identified and have since been resolved.

> Scope note: these are the only issues that surfaced from the **backend** suite. Many
> spec benchmarks (real-time multi-device sync, auto-save debounce, offline queue,
> optimistic-UI rollback, attachment upload timing, HTTPS/CORS in prod) are **client-side
> or infrastructure** concerns and cannot be validated at this layer — see `report.md` §5.

---

## 1. AUTH-08 — Access token (JWT) not revoked on logout · **medium**
- **Observed:** after `POST /auth/logout`, reusing the same access token on `GET /notes`
  still returns **200**. The refresh token *is* invalidated (AUTH-07 passes), but the
  stateless JWT remains valid until its `exp` (24h).
- **Risk:** a leaked/stolen access token cannot be killed by logging out; it lives up to 24h.
- **Recommended fix (≤2 files):**
  - Add a `token_version` int to the user doc; embed it in the JWT; reject in
    `verify_access_token` if it does not match. Bump on logout / password change.
  - *Or* maintain a short-TTL `jti` denylist in `db.sessions`.
- **Files:** `backend/auth/service.py`, `backend/auth/router.py`.

## 2. INP-03 — No server-side maximum payload size · **medium**
- **Observed:** a note with ~1.1 MB of `content` is accepted with **200**. No length cap on
  `content`, `title`, `images` (base64), or `attachments`.
- **Risk:** memory pressure / storage abuse on Atlas M0; MongoDB's own 16 MB document cap
  would surface as an unhandled 500 rather than a clean 4xx.
- **Recommended fix (1 file):** validate sizes in `create_note`/`update_note` (e.g.
  `content` ≤ 256 KB, total images ≤ a sane cap) → `400`/`413`; or add a body-size middleware.
- **Files:** `backend/server.py`.

---

## Items to verify on the live deployment (cannot assert locally)
- HTTPS/HSTS enforcement and HTTP→HTTPS redirect on Railway.
- CORS `ALLOWED_ORIGINS` actually restricted in production (defaults to `*` if unset).
- `Server` header not leaking `uvicorn`/version (strip via middleware if present).
- Real capture-speed latency, GET /notes p95, and Railway cold-start timing.

## Suggested next step
Approve fixes for AUTH-08 and INP-03 → implement on `fix/auto-repair` with the eval suite
as the regression gate (`pytest`), then re-run against a **staging** URL for latency/transport.
