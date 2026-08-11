# HANDOFF: Nueco

Generated 2026-08-11. Read AGENTS.md first.

> Sections marked TODO are for a human. Ask rather than guess.

## Where things stand

All code is committed, working tree clean. Not yet verified on a running device.

- **Voice onboarding** — full flow wired: onboarding screen → voice capture → scheduling-hint extraction → reminder/event creation. Not yet exercised end-to-end on a real or simulated device.
- **Account erasure (GDPR Art. 17)** — `accounts/service.py` erases all 9 user-scoped collections, S3 attachments, and push receipts, gated on password re-entry. Coverage is enforced by `TestErasureCoverage` in the integration suite.
- **Rate limiting** — `core/ratelimit.py` is live on auth endpoints (signup/login/reset by IP) and `textai` (AI quota by user). Feedback module retains its own inline limiter.
- **CI** — `backend-checks.yml` runs the user-scoping ratchet and a syntax check on every PR touching `backend/`.
- **Editor, events, perf** — image objects in the note editor, event detail view, all-day events, skeleton loaders, tab lazy-loading, and offline-sync fixes are all committed. None have been manually tested on this branch.

## In progress

Nothing. The branch is commit-complete with no uncommitted work.

## Decisions already made

Reconstructed from commit messages; amend if anything is wrong.

- **Onboarding gated on account age, not local notes** — `clearLocalData` runs on account deletion but not logout, so notes-based gating skipped onboarding after logout-then-register.
- **Daily Brew setup merged into the onboarding screen** — the two had drifted (a quote toggle existed in one but not the other, leaving it impossible to turn off). Brew toggles autosave; Confirm in onboarding means "done with this step", not "save".
- **Event emoji derived from title at render time, never stored** — no schema change, works on existing events, nothing persisted as a category the app asserts.
- **All-day events store a calendar date via a local-date formatter** — not `toISOString().slice`, which converts to UTC and lands on the wrong day east of Greenwich.
- **Editor back-navigation scoped with a `from=detail` flag** — `handleSaveAndBack` previously replaced to the events tab whenever `noteId` was absent, popping the detail screen; the flag keeps the other six entry points unchanged.
- **PDF text extraction moved on-device** (PDF.js in a WebView); the server endpoint that read user documents in plaintext was removed.
- **Attachments encrypted as chunked, streamed AES-256-GCM** so a 100MB file never loads whole; filenames encrypted too.
- **AI endpoints rate-limited per user with a global backstop** protecting the shared OpenAI quota; 429s carry `Retry-After`. Feedback keeps its own inline limiter.
- **User-scoping repository seam + CI ratchet** that fails on new unscoped queries — MongoDB has no row-level security, and that bug class fails open.
- **Erasure (GDPR Art. 17) gated on password re-entry**, covering all 9 user-scoped collections, S3 attachments, and push receipts; coverage enforced by `TestErasureCoverage`.
- **Events feed signature-gated with a shared 20s sync throttle** instead of full read + sync + double `setEvents` on every tab focus; pull-to-refresh still forces.
- **Dependencies repaired via clean install + `expo install --fix`**; `@react-native-community/netinfo` pinned to 11.5.2 (down from ^12.0.1) to match SDK 55.

## Dead ends: do not retry

- **`npm install` on the existing tree** — left node_modules broken; package-lock.json was already out of sync (expo-speech missing), so `npm ci` couldn't run either. Only clean install + `expo install --fix` works.
- **Expo web as a run target** — Metro dies on native crypto modules; needs a web-only KDF polyfill, stubs for `react-native-share`, and a local backend (the browser can't reach Railway from dev). Not usable out of the box.
- **Android emulator for screenshots on this machine** — architecture-mismatch crashes and System UI ANRs under software rendering; never stayed stable long enough to complete a capture pass.
- **Passing both voice and language to expo-speech** — Android resets to the default voice. Pass one or the other.
- **Removing `contentRef` tracking on edit** — broke deletion; had to be restored.
- **Legacy `*_test.py` scripts at repo root** — hit live infra; superseded by `tests/evals/` (see AGENTS.md).
