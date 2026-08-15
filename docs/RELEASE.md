# Release & Deployment Notes

Hand-written source of truth for release workflows. The generated wikis
(`*/.qoder/repowiki/`) reference the same facts but may be overwritten on
regeneration — this file survives.

## Frontend releases (Android)

- Built with Expo EAS. Profiles in `frontend/eas.json`: `development`,
  `preview`, `preview-bundle`, `production` (auto-incremented version, sets
  `NUESCO_RELEASE=1`), `production-apk`.
- Production AABs are uploaded to the **Google Play Console closed testing
  track**. Preview APK/AAB artifacts are also self-hosted for direct install.

### Release notes and testers

- Release notes entered per release appear under **"What's new"** on the Play
  Store listing for users on that track.
- Google Play does **not** notify closed testers (no push/email) on new
  releases; updates arrive via normal Play Store auto-update. Communicate
  releases out-of-band (e.g., shared channel with the opt-in link and notes).
- Testers join once via the opt-in link; later releases need no action from
  them.

### App Links (deep linking)

- The backend serves `/.well-known/assetlinks.json` with
  `delegate_permission/common.handle_all_urls` for `com.riostudio.memopad`.
- Cert fingerprints **must** be colon-separated uppercase hex SHA-256 strings
  (`5C:5E:...`) — Google's statement parser rejects base64 with
  `ERROR_CODE_MALFORMED_CONTENT`.
- The app declares the handled host via the Android intent filter in
  `app.json`/`app.config.js`.
- After changing `assetlinks.json`, re-run the App Links check in Play Console
  (Testing → App links).

## Backend deployment (Railway)

- Runs on Railway (project `diligent-happiness`, environment `production`),
  deployed via **CLI snapshot uploads** (`railway up` from `backend/`) — not a
  connected GitHub source.
- Builder is **DOCKERFILE** using `backend/Dockerfile`
  (python:3.12-slim → pip install → uvicorn). The service root directory is
  empty because `railway up` uploads the backend contents at the snapshot root.
- `backend/.railignore` excludes `.env`, `.env.example`, `.railway/`, and
  config-pull temp dirs from upload snapshots.
- The railpack builder is avoided: a mise download regression caused
  persistent prepare failures regardless of code content.

### Deploy steps

1. Stash any WIP that must not ship (e.g., `git stash push -m "wip" -- backend/events/`).
2. From `backend/`: `railway up --detach`.
3. Poll `railway deployment list` until SUCCESS.
4. Verify `GET /api/health` and `GET /.well-known/assetlinks.json`.
5. Restore WIP (`git stash pop`).

### Data residency gate

- All 18 AU data-residency env vars must be set in Railway — `core/regions.py`
  validates every external-service endpoint and region declaration against the
  AU allowlist at startup and refuses to boot otherwise.

## CI/CD

- `.github/workflows/backend-checks.yml` runs on every pull request and push
  to main with **no paths filter** (it is a required check, so it must always
  report a result). Job name: **Backend checks**.
- Steps: `scripts/check_user_scoping.py` (no new unscoped queries),
  `python -m compileall` (syntax), `pytest tests/test_regions.py` (residency).
- The `protect-main` repository ruleset enforces on main: changes must go
  through a PR, 1 approving review (stale reviews dismissed), the Backend
  checks status check, and blocks deletion/force-pushes. Designated bypass
  actors can override.
