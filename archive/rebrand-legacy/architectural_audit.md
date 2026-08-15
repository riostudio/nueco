# Nueco — Architectural Audit: Business Logic Coupling & Isolation

Scope: same codebase as `business_logic_map.md`. That document says *where* logic lives;
this one judges *how cleanly* — tight coupling, logic leaking into controllers/routes/UI, and
mixed responsibilities — and proposes a concrete extraction plan with a real before/after.

**Status: all six phases implemented and verified** (see §4).

All findings below are cited to specific files/lines as of this audit. Severity is rated by
blast radius (how many things break/must change together) and testability cost (can the rule
be unit-tested without spinning up the framework it currently lives inside).

---

## 1. Findings

### 1.1 — `server.py`: business workflows living directly in route handlers (Critical)

This is the dominant finding. Six endpoints in `backend/server.py` contain multi-step domain
workflows with zero service-layer seam — the `@api_router` decorator sits directly on top of
business logic, not a thin HTTP adapter over one.

| Endpoint | Lines | What's actually in there |
|---|---|---|
| `push_tick` | `server.py:250-374` (125 lines) | The entire reminder-delivery pipeline: stuck-claim recovery, atomic claim loop, Expo message construction, batched send with per-item error handling, receipt queuing, and recurrence rollforward — five distinct algorithmic steps in one function. |
| `push_receipts_tick` | `server.py:378-424` | Receipt-resolution + stale-token-pruning workflow. |
| `delete_account` | `server.py:165-189` | GDPR erasure orchestration: password re-verification, S3 cleanup ordering, 7-collection cascade delete. |
| `submit_feedback` | `server.py:446-503` | Validation + rate-limiting + AI-triage orchestration + persistence. |
| `record_feature_event` | `server.py:140-158` | Telemetry validation (event-name length, metadata-size cap). |
| `put_wrapped_key` | `server.py:113-127` | E2EE escrow blob-size validation across 4 fields. |

**Why this matters, concretely:** `push_tick` cannot be unit-tested today without booting the
full FastAPI app, wiring a real-or-mocked MongoDB, and mocking `httpx.AsyncClient` at the
transport layer inside a 125-line function — there is no importable unit that represents "the
reminder pipeline" on its own. The claim-atomicity invariant and the recurrence-rollforward
race-avoidance (both documented in inline comments as load-bearing correctness properties) are
exactly the kind of subtle logic that should have a dedicated test file, the way
`calendarSyncCore.test.ts` now covers the sync-planning logic — but there is no seam to attach
one to.

This is the same shape of problem `notes/` and `events/` had before the recent split (see
§2 for how that precedent directly informs the fix).

### 1.2 — Framework types imported into the business-logic layer (High)

`backend/CLAUDE.md`'s own architecture rules ("business logic must not import `fastapi`...
raise plain Python exceptions") are violated in two of five feature modules — and this is
*not* a hypothetical rule, it's already been enforced correctly in `notes/service.py` and
`events/service.py` (both raise plain `NoteNotFoundError`/`EventPayloadTooLargeError` etc.,
translated to HTTP status codes only in `router.py`).

```python
# backend/attachments/service.py:7
from fastapi import HTTPException

# backend/textai/service.py:7
from fastapi import HTTPException, UploadFile
```

Concretely, `attachments/service.py`'s `presign_upload` raises `HTTPException(status_code=400, ...)`
directly for a business rule ("file too large", "file type not allowed") — meaning that
function cannot be reused in a non-HTTP context (a CLI import tool, a batch job, a test) without
either dragging FastAPI along or catching-and-reraising at every call site.

### 1.3 — Six unrelated feature modules coupled to `auth.router`'s internals (Medium)

```python
# attachments/router.py, canva/router.py, dailybrew/router.py,
# textai/router.py, notes/router.py, events/router.py all do:
from auth.router import get_current_user, get_db
```

`get_db()` itself is a deferred/lazy import trick (`def get_db(): from server import db; return db`)
living inside `auth/router.py` — a module whose name and reason-for-being is "authentication,"
not "shared infrastructure." Six other feature modules now depend on an implementation detail
of a module that has nothing to do with what they need (a DB handle and a decoded user). This
is already flagged as accepted debt in `CLAUDE.md`, and it grew by two more instances (`notes/`,
`events/`) during the last refactor purely to stay consistent with the existing pattern rather
than introduce a third convention — but it means any future change to `auth/router.py`'s
internals has a blast radius of six unrelated features.

### 1.4 — Frontend: the login/E2EE/sync workflow lives inside a React Context provider (High)

`frontend/src/auth/context/AuthContext.tsx`'s `login()` callback (lines 146-229) sequences a
genuine multi-step business workflow: set user state → fire a calendar-permission request →
**await** E2EE key bootstrap (with three-way branching on `created`/`needs_recovery`/`unlocked`)
→ background full sync → gated one-time E2EE migration → re-fetch-and-reconcile the account
name's encryption state. The *ordering* here is load-bearing and subtly documented in code
comments (e.g. "must re-fetch with the DEK now in place instead ... pushing that stale object
back would permanently bake the ciphertext in as the plaintext name").

None of this sequencing can be unit-tested without mounting a React tree and a `Context.Provider`
— even though nothing about *which step runs in what order and why* is actually a React
concern. Contrast this with `crypto/keySession.ts`, which already extracts the pure
DEK-lifecycle state machine (`bootstrapKeyOnLogin`, `recoverKeyWithCode`) out of the UI layer;
`AuthContext.tsx` calls that module correctly, but then re-embeds a *second*, higher-level
workflow (the login sequencing itself) directly in the provider instead of extracting it the
same way.

### 1.5 — Frontend: duplicated (and silently divergent) domain logic (Medium)

`frontend/src/offlineSync.ts` already implements the local-first create/update/delete/sync-queue
pattern for events (`createEventOffline`, `updateEventOffline`, `deleteEventOffline`). But
`frontend/src/useOfflineNotes.ts:218-310` (`useOfflineEvents`'s `createEvent`/`updateEvent`/
`deleteEvent`) reimplements the *same* pattern inline in a hook instead of calling those
functions:

```typescript
// useOfflineNotes.ts:218-251 — reimplements offlineSync's createEventOffline from scratch
const createEvent = useCallback(async (data: Omit<LocalEvent, 'id' | 'created_at' | '_isLocal'>) => {
  const now = new Date().toISOString();
  const tempId = `local_${uuid.v4()}`;
  const event: LocalEvent = { ...data, id: tempId, created_at: now, _isLocal: true };
  await upsertLocalEvent(event);
  await loadEvents();
  await enqueueOperation({ id: tempId, entity: 'event', operation: 'create', payload: data, timestamp: now });
  const online = await checkOnline();
  if (online) { try { await processSyncQueue(); } catch (e) {} await loadEvents(); }
  return event;
}, [loadEvents]);
```

This isn't just duplication — it's already **behaviorally diverged** from the canonical
implementation: `offlineSync.ts`'s `createEventOffline` has a documented special case (inline
create-and-resolve, bypassing `processSyncQueue()`) specifically so a caller can get the real
server id synchronously to link a note to the new event in the same action. `useOfflineEvents.createEvent`
has no such path — any screen that ends up using this hook's version instead of the offlineSync
function directly gets subtly different guarantees with no compiler or test signal that the two
have drifted.

### 1.6 — An invariant enforced in one place but not its structural twin (Low-Medium)

`backend/dailybrew/service.py`'s `_reject_private_host` SSRF guard (DNS-resolve, reject
private/loopback/link-local IPs, re-validate on every redirect hop) exists because the backend
fetches a user-influenced URL (a custom RSS feed). `frontend/src/share/unfurl.ts` does the
structurally identical thing — fetches a user-shared URL to scrape metadata — with no equivalent
guard. This isn't a duplication problem, it's a case where the same *class* of rule ("don't let
this app be used as an SSRF proxy for a user-supplied URL") should be recognized as one
cross-cutting invariant and isn't — it was solved once, locally, and not generalized or even
flagged for the other call site.

---

## 2. Refactoring Plan

The plan leans on a pattern this repo has already validated twice — once for
`calendarSyncCore.ts` (frontend pure-logic extraction) and once for `notes/`/`events/` (backend
service-layer extraction). Rather than propose a new architecture, this generalizes the one
already in place to the remaining leak sites.

### Phase 1 — Backend: extract `push_tick`'s pipeline into a service (highest value, §1.1)
1. Create `backend/reminders/service.py` with a `RemindersService(db, expo_client)` class —
   `expo_client` is an injected thin wrapper around the two Expo HTTP calls, so the pipeline's
   business logic (claim/build/send-orchestration/rollforward) can be unit-tested with a fake
   sender instead of mocking `httpx` at the transport layer.
2. Split into named methods mirroring the five documented steps: `recover_stuck_claims()`,
   `claim_due_reminders()`, `build_messages(claimed)`, `send_and_track(messages)`,
   `advance_recurring(claimed)` — each independently testable, matching the granularity the
   inline comments already describe.
3. `server.py`'s `push_tick` route becomes: check the tick secret, call
   `RemindersService(db, expo_client).run_tick()`, return the result dict. Same treatment for
   `push_receipts_tick`.
4. Apply the same extraction to `delete_account` (→ `backend/accounts/service.py`, an
   `AccountsService.erase(user_id, password)` method) and `submit_feedback` (→
   `backend/feedback/service.py`).

### Phase 2 — Backend: stop importing `fastapi` in service layers (§1.2)
- `attachments/service.py` and `textai/service.py`: replace `raise HTTPException(...)` with
  plain exceptions (`AttachmentTooLargeError`, `UnsupportedFileTypeError`,
  `TranscriptionFailedError`, etc. — exactly the pattern `notes/service.py`'s
  `NotePayloadTooLargeError` already established), caught and translated in their `router.py`
  files.

### Phase 3 — Backend: shared auth dependency module (§1.3, lower priority — wide blast radius)
- Introduce `backend/core/deps.py` holding `get_current_user`/`get_db`; update all six
  `router.py` files to import from there instead of `auth.router`. This is a mechanical but
  wide-touching change (6 files) that's safe to schedule independently of Phases 1-2 — flagging
  it here rather than bundling it in, since it doesn't unblock any of the higher-severity items.

### Phase 4 — Frontend: extract the login workflow out of `AuthContext.tsx` (§1.4)
- Create `frontend/src/auth/loginWorkflow.ts`: a pure-ish orchestration function
  `runPostLoginWorkflow(deps)` where `deps` is an injected bag of the actual side-effecting
  calls (`bootstrapKeyOnLogin`, `fullSync`, `migrateNotesToEncrypted`, `migrateEventsToEncrypted`,
  `authApi.getMe`, `pushBackPlaintextName`) — the function owns *sequencing and branching*, the
  injected deps own *doing*. This mirrors exactly how `keySession.ts` already isolates the DEK
  state machine from `AuthContext.tsx`; the missing piece is doing the same one level up, for
  the workflow that currently calls `keySession.ts`.
- `AuthContext.tsx`'s `login()` shrinks to: call `authApi.login`, set state, call
  `runPostLoginWorkflow(realDeps)`. The ordering/branching logic becomes testable with fake
  deps and no React renderer.

### Phase 5 — Frontend: de-duplicate `useOfflineEvents` (§1.5)
- Rewrite `useOfflineEvents`'s `createEvent`/`updateEvent`/`deleteEvent` to call
  `createEventOffline`/`updateEventOffline`/`deleteEventOffline` from `offlineSync.ts` instead
  of reimplementing them — removing the behavioral drift and the duplicate maintenance surface.

### Phase 6 — Generalize the SSRF guard (§1.6)
- Extract `_reject_private_host` + the redirect-revalidation loop from
  `dailybrew/service.py` into a small standalone `backend/security/ssrf_guard.py` (or, if a
  frontend equivalent is wanted for `unfurl.ts`, document the *rule* once in
  `business_logic_map.md`'s invariants section — done — and treat the frontend gap as a tracked
  follow-up rather than silently accepted.

---

## 3. Before / After — `push_tick` (Phase 1, worked example)

### Before — `backend/server.py:250-374` (verbatim, abridged for space; full function is 125 lines)

```python
@api_router.post("/internal/push/tick")
async def push_tick(request: Request):
    """Cron-driven (once/minute). Claims due reminders atomically, sends them via Expo in
    batches, handles per-item results, and records tickets for later receipt resolution..."""
    _require_tick_secret(request)
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()

    # 1) Recover stuck claims
    stuck_before = (now - timedelta(minutes=5)).isoformat()
    await db.events.update_many(
        {"reminder_status": "claimed", "reminder_claimed_at": {"$lt": stuck_before}},
        {"$set": {"reminder_status": "pending", "reminder_claimed_at": None}},
    )

    # 2) Atomically claim due, pending reminders
    claimed = []
    while len(claimed) < 500:
        ev = await db.events.find_one_and_update(
            {"reminder_minutes": {"$ne": None}, "reminder_status": "pending",
             "reminder_fire_at": {"$lte": now_iso}},
            {"$set": {"reminder_status": "claimed", "reminder_claimed_at": now_iso}},
            return_document=ReturnDocument.AFTER,
        )
        if not ev:
            break
        claimed.append(ev)
    if not claimed:
        return {"claimed": 0, "sent": 0}

    # 3) Build one Expo message per (event, active token)
    messages = []
    for ev in claimed:
        tokens = await db.push_tokens.find({"user_id": ev["user_id"], "active": True}).to_list(20)
        if not tokens:
            await db.events.update_one({"id": ev["id"]}, {"$set": {"reminder_status": "sent"}})
            continue
        push_title = 'Event Reminder' if ev.get('enc_version') else (ev.get('title') or 'Event Reminder')
        for t in tokens:
            messages.append((ev["id"], t["token"], {
                "to": t["token"], "title": f"⏰ {push_title}",
                "body": f"Starts in {reminder_label(ev.get('reminder_minutes'))}",
                "data": {"eventId": ev["id"], "kind": "event-reminder"},
                "sound": "default", "channelId": "event-reminders",
            }))

    # 4) Batch-send via httpx directly, inline error handling ...
    # 5) Recurrence rollforward, inline ...
    # (17 more lines each, omitted here — see server.py for the full text)

    return {"claimed": len(claimed), "sent": len(processed_event_ids), "tickets": len(receipts)}
```

**Problems this before-state has, concretely:**
- No test file exists (or can cheaply exist) for the claim-atomicity guarantee, the
  no-active-tokens-marks-sent rule, or the recurrence-rollforward-only-on-claimed-batch
  invariant — all three are documented in comments as correctness-critical, none are tested.
- `httpx.AsyncClient` is instantiated inline — testing "what happens on an Expo 5xx" means
  mocking a transport layer inside a route handler, not calling a function.
- The function mixes three levels of abstraction (raw Mongo queries, HTTP batching/retry
  policy, and the recurrence domain rule) with no visual or structural boundary between them.

### After — extracted service + thin route

```python
# backend/reminders/service.py
"""Business logic for the reminder-delivery pipeline. Framework-agnostic: takes `db` and an
injected Expo client, raises nothing HTTP-specific. server.py's push_tick route is a thin
adapter over run_tick()."""
from datetime import datetime, timedelta, timezone
from pymongo import ReturnDocument

from events.schemas import Recurrence
from events.service import next_occurrence_on_or_after, reminder_label


class RemindersService:
    def __init__(self, db, expo_client):
        self.db = db
        self.expo = expo_client  # thin wrapper: send_batch(messages), see ExpoClient below

    async def recover_stuck_claims(self, now: datetime) -> None:
        stuck_before = (now - timedelta(minutes=5)).isoformat()
        await self.db.events.update_many(
            {"reminder_status": "claimed", "reminder_claimed_at": {"$lt": stuck_before}},
            {"$set": {"reminder_status": "pending", "reminder_claimed_at": None}},
        )

    async def claim_due_reminders(self, now_iso: str, limit: int = 500) -> list[dict]:
        claimed = []
        while len(claimed) < limit:
            ev = await self.db.events.find_one_and_update(
                {"reminder_minutes": {"$ne": None}, "reminder_status": "pending",
                 "reminder_fire_at": {"$lte": now_iso}},
                {"$set": {"reminder_status": "claimed", "reminder_claimed_at": now_iso}},
                return_document=ReturnDocument.AFTER,
            )
            if not ev:
                break
            claimed.append(ev)
        return claimed

    async def build_messages(self, claimed: list[dict]) -> list[tuple]:
        messages = []
        for ev in claimed:
            tokens = await self.db.push_tokens.find(
                {"user_id": ev["user_id"], "active": True}).to_list(20)
            if not tokens:
                await self.db.events.update_one({"id": ev["id"]}, {"$set": {"reminder_status": "sent"}})
                continue
            push_title = 'Event Reminder' if ev.get('enc_version') else (ev.get('title') or 'Event Reminder')
            for t in tokens:
                messages.append((ev["id"], t["token"], {
                    "to": t["token"], "title": f"⏰ {push_title}",
                    "body": f"Starts in {reminder_label(ev.get('reminder_minutes'))}",
                    "data": {"eventId": ev["id"], "kind": "event-reminder"},
                    "sound": "default", "channelId": "event-reminders",
                }))
        return messages

    async def send_and_track(self, messages: list[tuple], now_iso: str) -> tuple[set, list[dict]]:
        processed_event_ids, receipts = set(), []
        for i in range(0, len(messages), 100):
            batch = messages[i:i + 100]
            results = await self.expo.send_batch([m for (_e, _t, m) in batch])
            if results is None:  # whole call failed - leave 'claimed' for retry
                continue
            for (eid, token, _msg), result in zip(batch, results):
                processed_event_ids.add(eid)
                if result.get("status") == "ok" and result.get("id"):
                    receipts.append({"ticket_id": result["id"], "event_id": eid, "token": token,
                                      "created_at": now_iso, "checked": False})
                elif (result.get("details") or {}).get("error") == "DeviceNotRegistered":
                    await self.db.push_tokens.update_one({"token": token}, {"$set": {"active": False}})
        if processed_event_ids:
            await self.db.events.update_many(
                {"id": {"$in": list(processed_event_ids)}}, {"$set": {"reminder_status": "sent"}})
        return processed_event_ids, receipts

    async def advance_recurring(self, claimed: list[dict], now: datetime) -> None:
        for ev in claimed:
            if not ev.get("recurrence"):
                continue
            try:
                recurrence = Recurrence(**ev["recurrence"])
                next_dt = next_occurrence_on_or_after(
                    ev.get("start_time"), recurrence, ev.get("timezone"), now + timedelta(seconds=1))
                if next_dt is None:
                    continue
                new_fire_at = next_dt - timedelta(minutes=ev["reminder_minutes"])
                await self.db.events.update_one({"id": ev["id"]}, {"$set": {
                    "reminder_status": "pending", "reminder_fire_at": new_fire_at.isoformat(),
                    "reminder_claimed_at": None}})
            except Exception:
                pass  # one corrupt recurrence rule only strands that event

    async def run_tick(self) -> dict:
        now = datetime.now(timezone.utc)
        now_iso = now.isoformat()
        await self.recover_stuck_claims(now)
        claimed = await self.claim_due_reminders(now_iso)
        if not claimed:
            return {"claimed": 0, "sent": 0}
        messages = await self.build_messages(claimed)
        processed, receipts = await self.send_and_track(messages, now_iso)
        await self.advance_recurring(claimed, now)
        if receipts:
            await self.db.push_receipts.insert_many(receipts)
        return {"claimed": len(claimed), "sent": len(processed), "tickets": len(receipts)}
```

```python
# backend/reminders/expo_client.py
"""Thin adapter over the two Expo HTTP calls - the only place httpx/network concerns
touch the reminder pipeline. Swappable with a fake in tests."""
import httpx


class ExpoClient:
    SEND_URL = "https://exp.host/--/api/v2/push/send"

    def __init__(self, headers_fn):
        self._headers_fn = headers_fn

    async def send_batch(self, messages: list[dict]) -> list[dict] | None:
        try:
            async with httpx.AsyncClient(timeout=30) as http:
                resp = await http.post(self.SEND_URL, headers=self._headers_fn(), json=messages)
                return resp.json().get("data", [])
        except Exception:
            return None  # caller leaves the batch's events 'claimed' for retry
```

```python
# backend/server.py — route becomes a thin adapter
@api_router.post("/internal/push/tick")
async def push_tick(request: Request):
    _require_tick_secret(request)
    service = RemindersService(db, ExpoClient(_expo_headers))
    return await service.run_tick()
```

**What this buys, concretely:**
- `RemindersService.claim_due_reminders` and `advance_recurring` are now each independently
  unit-testable against a mock-Mongo `db` (the same `mongomock_motor` setup already used in
  `backend/tests/test_nueco_apis.py`) — no FastAPI app, no real Expo call, no route needed to
  exercise the claim-atomicity or recurrence-rollforward logic.
- `send_and_track` can be tested against a fake `ExpoClient` whose `send_batch` returns
  canned success/error/`None` responses — covering the `DeviceNotRegistered` token-deactivation
  path and the whole-batch-failure retry path without a network call.
- The route (`push_tick`) is now 4 lines and does exactly what a router should: check auth
  (the tick secret), call the service, shape the response.

---

## 4. Priority Order and Implementation Status

1. **Phase 1 — DONE.** `push_tick`/`push_receipts_tick` extracted into
   `backend/reminders/service.py` (`RemindersService` + `ExpoClient`), matching the worked
   example in §3 exactly. `delete_account` extracted into `backend/accounts/service.py`
   (`AccountsService.erase`, raises `UserNotFoundError`/`IncorrectPasswordError`).
   `submit_feedback` extracted into `backend/feedback/service.py` (`FeedbackService.submit`;
   the module-level `RateLimiter` moved here too, since feedback was its only consumer).
   `server.py`'s three routes are now each a handful of lines. Verified: full existing pytest
   suite (27/28 - the 1 failure is a pre-existing unrelated test bug, confirmed identical on
   the pre-refactor code), plus a new end-to-end smoke test exercising rate-limiting, AI-triage
   failure-tolerance, the atomic-claim/recurrence-rollforward pipeline, wrong-tick-secret 403,
   wrong-password 401, and the full account-erasure cascade against a mock DB.
2. **Phase 4 — DONE.** `AuthContext.tsx`'s `login()` sequencing extracted into
   `frontend/src/auth/loginWorkflow.ts` (`runLoginWorkflow`) - genuinely framework-free (only
   type-only imports; the `E2EE_KEYS_ENABLED` flag is injected rather than imported, since
   `crypto/flags.ts` itself pulls in `expo-constants`). `login()` shrank from ~84 lines to
   ~20. Verified: new `loginWorkflow.test.ts` (25 assertions, plain Node, no React/Expo
   runtime) covering the bootstrap/migration/push-back branching and the
   fire-and-forget-vs-awaited timing; full `tsc --noEmit` clean.
3. **Phase 5 — DONE.** `useOfflineEvents`'s `createEvent`/`updateEvent`/`deleteEvent` now call
   `createEventOffline`/`updateEventOffline`/`deleteEventOffline` from `offlineSync.ts` instead
   of reimplementing them - the drift noted in §1.5 (missing the synchronous-server-id special
   case) is gone because there's only one implementation now. (This hook turned out to have no
   live call sites in any screen today - screens call `offlineSync.ts` directly - so the fix
   was zero-risk to ship.)
4. **Phase 2 — DONE.** `attachments/service.py` and `textai/service.py` no longer import
   `fastapi` at all: plain exceptions (`AttachmentTooLargeError`,
   `UnsupportedAttachmentTypeError`, `AIEmptyResponseError`, `InvalidTextActionError`, etc.)
   translated in each `router.py`. `textai/router.py` also now unwraps `UploadFile` itself
   before calling `service.transcribe_bytes`, so `service.py` never types a parameter as
   `UploadFile` either - `transcribe_upload` (the function that used to do that unwrapping
   inside the service layer) was removed. `CLAUDE.md`'s known-debt list updated to drop this
   item and reflect the new module list. Verified: service-layer exception checks run directly
   (bypassing HTTP), plus an end-to-end smoke test confirming the 503/400/403/502 translations
   still fire with the same status codes as before.
5. **Phase 3 — DONE.** `backend/core/deps.py` now holds `get_current_user`/`get_db`; all ten
   router modules (`auth` itself included) import from there instead of `auth.router`. Hit and
   fixed a real circular import along the way: `auth/__init__.py` eagerly imports `auth.router`,
   which now imports `core.deps`, which needs `AuthService` from `auth.service` - importing
   that at module load time round-tripped back through `auth`'s package init before either
   module finished loading. Fixed with a deferred import inside `get_current_user` (the same
   pattern `get_db` already used for `server.db`), not by touching the unrelated
   `auth/__init__.py`. `CLAUDE.md` updated - the shared-dependency-module debt item is gone.
   Verified: full route-registration check (64 routes), full pytest suite, both Phase 1/2
   smoke tests (which exercise `get_current_user`/`get_db` through accounts/feedback/
   attachments/reminders), and a route-existence check confirming canva/dailybrew still wire up.
6. **Phase 6 — DONE.** `backend/security/ssrf_guard.py` now holds the generalized guard:
   `reject_private_host` (the DNS-resolve + private-IP-range check) and `safe_get` (the
   manual-redirect-with-per-hop-revalidation fetch), both reusable by any future feature that
   needs to safely fetch a user-influenced URL - not RSS/feed-specific in any way.
   `dailybrew/service.py`'s `fetch_custom_feed_name` shrank to: call `ssrf_guard.safe_get`,
   translate its three exception types back to the same three user-facing `ValueError`
   messages as before, then interpret the response as RSS/Atom (the one genuinely
   feed-specific step, left in `dailybrew/`). The frontend gap (`share/unfurl.ts` has no
   equivalent guard) is intentionally NOT fixed here - it needs its own client-side solution,
   already tracked in `business_logic_map.md`'s invariants section rather than silently
   dropped. Verified: direct unit checks against the extracted guard (scheme rejection,
   loopback/private/link-local rejection, DNS-failure rejection, a real successful public
   fetch), a direct check that `fetch_custom_feed_name`'s error messages are byte-identical to
   before (including a real live RSS feed for the happy path), and an end-to-end HTTP check
   through `POST /api/dailybrew/custom-feed` confirming both the 400 rejection and the 200
   success case work through the full router → service → guard stack.

Every phase above was verified the same way the original `notes`/`events` split was: real
files, wired in, exercised end-to-end against a mock-DB harness and the existing test suite,
not just read through.
