# MemoPad — Performance Audit

Scope: backend (FastAPI + MongoDB) and frontend (Expo/React Native) runtime performance —
not architecture or code organization (see `architectural_audit.md` for that). Findings are
ranked by actual measured/reasoned impact, with file:line citations. Two findings are
deliberately **not** fixed in this pass because the "fix" is really a storage-architecture
redesign with a real user-facing trade-off (offline data availability) — flagged clearly
rather than silently done or silently skipped.

---

## Findings

### Backend

**B1 — `bcrypt` blocks the entire event loop on every login/signup/password-change/account-deletion (Critical, FIXED)**

`auth/service.py:49-53` (`_hash_password`/`_verify_password`) and `accounts/service.py:38`
called `bcrypt.hashpw`/`bcrypt.checkpw` directly and synchronously inside `async def`
functions — unlike the boto3 S3 calls elsewhere in the codebase, which are correctly wrapped
in `asyncio.to_thread`. Measured on this hardware: **~255-260ms per call**, fully CPU-bound.

Since this is a single-worker deployment (per existing comments elsewhere, e.g.
`canva/service.py`'s "Railway runs a single replica" note), this means: for a quarter of a
second, the entire server can't handle *any* request from *any* user, not just the one
authenticating. Two people logging in at the same moment serialize behind each other. This
was the single biggest finding in the audit — not a slow endpoint, a periodic full-server
freeze, on the hottest auth paths (login, signup, every password change, every account
deletion).

**B2 — Notes pagination sort isn't fully index-covered (Medium-High, FIXED)**

`notes/service.py`'s `list()` sorts by `[("is_pinned", -1), ("updated_at", -1)]` — a two-key
sort. The indexes (`server.py`) were two *separate* compound indexes, `(user_id, updated_at)`
and `(user_id, is_pinned)`, not one combined `(user_id, is_pinned, updated_at)` index.
MongoDB needs a single index whose fields match the query's equality + sort fields, in order,
to avoid an in-memory sort stage — two separate indexes can't jointly satisfy one compound
sort. In practice this means every `GET /api/notes` call likely did a blocking in-memory sort
after the user_id filter, scaling with that user's total note count (fine at dozens of notes,
increasingly costly into the hundreds/thousands; MongoDB caps in-memory sorts at 32MB, past
which it errors rather than just being slow).

**B3 — The notes list endpoint returns full base64 images the client never displays in the list (Medium, DEFERRED)**

`notes/service.py`'s `list()` projects `"images": 1` into every `GET /api/notes` response.
The note-list screen (`app/(tabs)/index.tsx`) never renders `note.images` — images are only
needed when a specific note is opened in the editor. So every full sync downloads
full-resolution base64 image data for every image-bearing note, for no reason the list
screen uses.

**Why this is deferred, not fixed:** MemoPad is local-first and offline-capable by design —
`fullSync()` fetches every note via this exact endpoint and caches the *complete* result
(including images) in `notes.json`, so a note opens instantly with its images even with no
network connection. Simply dropping `images` from this projection would silently break
offline image viewing/editing until a device happened to be online and re-fetched that
specific note individually — a real behavior regression, not a pure performance win. Properly
fixing this needs one of: (a) a separate, independently-synced image store (so images sync in
the background without blocking the list payload, while still ending up available offline),
or (b) an explicit product decision to make images network-dependent when opening a note.
Either is a real design change, not a safe incremental patch — flagged here for a deliberate
follow-up rather than done silently or dropped silently.

### Frontend

**F1 — Every note/event save rewrites the *entire* local collection to disk (High, DEFERRED)**

`offlineSync.ts`'s `upsertLocalNote`/`upsertLocalEvent` read the full notes/events array,
splice in the one change, and write the **whole array** back via `JSON.stringify` +
`writeAsStringAsync`, for every create/update/delete. Autosave is properly debounced (~800ms,
and events additionally skip no-op saves via a content hash), so this isn't per-keystroke —
but a multi-minute editing session still triggers dozens of full-collection rewrites, scaling
with *total* notes size rather than the one note being edited. Gets worse together with B3
(images bloating that same payload).

**Why this is deferred, not fixed:** the single-JSON-file-per-collection scheme is a
deliberate, documented choice from an earlier fix — it replaced per-key AsyncStorage
specifically to route around Android's ~2MB `CursorWindow` read cap that was silently
corrupting reads for users with many/large notes. Moving to a per-note-file scheme to avoid
the full-rewrite cost would reintroduce a different set of problems (many small file
reads to reconstitute a list, directory-listing overhead, partial-write consistency across
files) that need real design, not a quick patch, and touches the same subsystem a past bug
already burned us on. Flagged for a dedicated follow-up, not attempted piecemeal here.

**F2 — Calendar month grid recomputes event-matching for every cell on every render, unmemoized (Medium, FIXED)**

`calendar.tsx` called `eventOccursOnDay` once per day cell (~35-42 cells) per render,
scanning the full events array each time (`hasEvents`), with zero caching between renders.
The genuinely dangerous case (unbounded day-stepping search for recurring events) was already
fixed in an earlier session — this remaining cost is O(days × events) but bounded, not
unbounded. Still, every tap on a day, month change, or unrelated state update redid the full
pass with no memoization.

**F3 — Events tab recomputes grouping/sorting on every render, including scroll-driven state changes (Medium, FIXED)**

`events.tsx`'s `groupEventsByDate` (unmemoized) ran on every re-render of the screen, and
scroll handling (`scrollEventThrottle={16}`) drives FAB-expand state changes that trigger
re-renders during scrolling — so grouping/sorting reran while the user was just scrolling,
not just when the underlying data changed.

**F4 — Missing `React.memo`/`useCallback` on list row renderers (Low, FIXED)**

Virtualization (`FlatList`) is correctly in place for the main lists — the big lever was
already pulled. This mostly affected interaction smoothness under unrelated state churn
(e.g. search-box typing re-rendering every visible row), not memory or scroll performance
at scale.

**F5 — Image compression is quality-only, no dimension resize (Low, FIXED — unverified on device)**

`editor.tsx`'s camera/gallery picker used `quality: 0.7` (JPEG compression) but never
downsampled pixel dimensions, so a modern phone photo could still produce a multi-MB base64
string regardless of the quality setting. Feeds directly into F1 and B3's payload-size
concerns.

---

## Fix Summary

| # | Finding | Status | Risk |
|---|---|---|---|
| B1 | bcrypt blocking the event loop | **Fixed** | Low — mechanical `asyncio.to_thread` wrap |
| B2 | Notes sort not index-covered | **Fixed** | Low — additive index change |
| B3 | Images over-fetched in note list | **Deferred** | N/A — needs a storage-architecture decision |
| F1 | Full-collection rewrite per save | **Deferred** | N/A — needs a storage-architecture decision |
| F2 | Calendar grid unmemoized | **Fixed** | Low — pure render optimization |
| F3 | Events grouping unmemoized | **Fixed** | Low — pure render optimization |
| F4 | Missing memo/useCallback on rows | **Fixed** | Low — pure render optimization |
| F5 | No image dimension resize | **Fixed** | Medium — new native dependency, **not verified on a real device/simulator** (no working native runtime in this environment); needs a manual test pass before shipping |

---

## Verification

**B1 (bcrypt off the event loop).** `auth/service.py`'s `_hash_password`/`_verify_password` and
`accounts/service.py`'s password check now `await asyncio.to_thread(...)`. Confirmed the GIL is
actually released during bcrypt's C call (a concurrent spin-loop thread kept incrementing while
`bcrypt.checkpw` ran, ruling out a GIL-holding C extension as a blocker). Wrote an end-to-end
regression test: a login request (bcrypt-bound) and a `/api/health` request fired concurrently
over the real ASGI app — before understanding the fix correctly, an initial version of this test
had a scheduling bug that produced a false failure; a corrected version with explicit per-request
timestamps confirms the health check starts at t=20ms and finishes at t=22.3ms while the login is
still running until t≈238-255ms. Full existing pytest suite still 27/28 (1 pre-existing unrelated
failure, unchanged).

**B2 (compound index for notes sort).** Replaced the two separate `(user_id, updated_at)` /
`(user_id, is_pinned)` indexes with one `(user_id, is_pinned, updated_at)` index matching
`notes/service.py`'s `list()` filter+sort exactly. Added explicit `drop_index` calls for the two
superseded index names so an already-deployed database doesn't keep carrying dead indexes
forever. Verified `create_indexes()` runs clean against a fresh mock DB and produces exactly the
expected index; full pytest suite and the notes/events end-to-end smoke test both still pass.

**F2/F3 (calendar + events memoization).** Both are pure `useMemo`/hoisted-pure-function changes
with no behavior change to what's computed, only when. `tsc --noEmit` clean; every existing
frontend test file (359 assertions across 10 files, including `recurrence.test.ts` which the
calendar screen's logic depends on) still passes.

**F4 (notes list memoization).** `filteredNotes`/`pinnedNotes`/`otherNotes` wrapped in `useMemo`;
`renderCard`, `handleTogglePin`, `handleDeletePress`, and the `FlatList`'s `renderItem` wrapped in
`useCallback` with correct dependency arrays. `tsc --noEmit` clean. Did not extract a
`React.memo`-wrapped row component — that's a larger structural change (pulling the card JSX into
its own component/file) with more surface area for prop-passing bugs than this pass's scope;
flagging it as a further, not-yet-taken step if row re-render is still a bottleneck after this.

**F5 (image resize).** Added `expo-image-manipulator` (official Expo SDK package, matching the
installed Expo SDK version) via `npx expo install`, so the lockfile-resolved version is
guaranteed compatible. `resizeImageForNote` downscales the longest edge to 1600px before
inlining as base64, with a hard fallback to the original (unresized) base64 on any failure so a
resize error never blocks attaching a photo. **Not verified on a real device or simulator** — this
environment has no working native runtime, and `expo-image-manipulator` is a native module that
can't be exercised under plain Node the way the rest of this codebase's pure logic can. `tsc
--noEmit` is clean and the code review is straightforward, but this needs a real device/simulator
test pass (take a photo, pick from gallery, confirm the note still saves/displays correctly, and
ideally confirm the resulting base64 is meaningfully smaller for a large source photo) before
shipping.
