# Nueco — Calendar Sync & Event-Reminder Push Infrastructure (v3)

_Status: **planned** (not yet implemented). This doc is the implementation plan for
two related features: (1) native Google/Apple calendar sync without a browser
redirect, and (2) server-driven push notifications for event reminders, with an
optional spoken ("voice") reminder._

_Decisions locked with the product owner (2026-07-05):_
- _Calendar sync: **device-calendar only** (reuse `expo-calendar`), no server-side
  Google/Apple OAuth in v1._
- _Voice reminder: **tap-to-speak**, gated by a Profile setting, **default OFF**._

_v2 changes: added push receipt handling, batched sends, partial index, past-due
guard on create, resolved the local-vs-push dedup question, and resolved the
scheduler-placement open decision in favour of Railway cron over a persistent
worker._

_v3 changes: replaced the boolean `reminder_sent` idempotency guard with a
claim/send state machine (fixes a real bug — v2's ordering could permanently lose a
reminder on a network failure mid-send), added stuck-claim recovery, handled partial
batch-send responses per-item instead of all-or-nothing, and added a staged rollout
recommendation before full launch. See §11 for the full changelog._

## 1. Goals

1. A user can **create or link** an event in Nueco and have it **auto-sync to the
   device's Google or Apple calendar** with no redirect to `calendar.google.com`.
2. Event reminders are delivered as **push notifications** driven by backend
   infrastructure (not only on-device local scheduling), so a reminder fires even if
   the app was never reopened after the event was created.
3. Optionally, when the user opts in, tapping a reminder makes the app **speak the
   reminder aloud** (TTS).

### Non-goals (v1)
- **Server-side calendar APIs.** No Google Calendar OAuth / token storage, no CalDAV
  to iCloud. Sync is via the OS calendar store only. (Deferred — see §8, Tier 2.)
- **Lock-screen voice autoplay.** The OS does not allow autoplaying arbitrary audio
  from a background/lock-screen push without the iOS **Critical Alerts** entitlement
  (special Apple approval). Out of scope. Voice happens on tap, foregrounded.
- **Two-way calendar sync.** We write to the device calendar and track the created
  event id; we do not import external calendar changes back into Nueco.
- **Multiple reminders per event.** Single `reminder_minutes` per event stays as-is
  in v1 (see §10, resolved).

## 2. Current state (what already exists)

| Piece | State | Reference |
|---|---|---|
| `expo-calendar` dependency + config plugin (+ permission string) | ✅ installed & configured | `frontend/app.json:71`, `frontend/package.json` (`expo-calendar` ~55.0.14) |
| `writeToDeviceCalendar()` — writes event to native calendar, no redirect | ✅ working; picks default cal (iOS) / Google-synced cal (Android) | `frontend/app/event-editor.tsx:225` |
| `device_calendar_event_id` persisted round-trip | ✅ in model + create/update | `backend/server.py:171`, `:571` |
| Legacy `syncToGoogleCalendar()` — opens `calendar.google.com/render?...` | ⚠️ **to be removed** | `frontend/app/event-editor.tsx:277` |
| `scheduleReminder()` — **local** notification only | ✅ works, but on-device only | `frontend/app/event-editor.tsx:296` |
| `expo-notifications` dependency | ✅ installed (~55.0.23) | `frontend/package.json` |
| `expo-notifications` **config plugin** (push channel, APNs) | ❌ missing from plugins array | `frontend/app.json:59` |
| Push token registration / storage | ❌ none | — |
| Backend push send path / scheduler | ❌ none | — |
| Push receipt polling | ❌ none (new in v2) | — |
| `expo-speech` (TTS) | ❌ not installed | — |
| `expo-av` / `expo-audio` (audio playback) | ✅ installed | `frontend/package.json` |

**Takeaway:** the calendar-sync feature is ~80% built and needs hardening + a
picker; the push/voice feature is greenfield infrastructure.

## 3. Feature A — Native calendar sync (device-only)

### 3.1 Behaviour
- On event save, write to the device calendar via the existing
  `writeToDeviceCalendar()` and store the returned id in `device_calendar_event_id`.
- Add a **calendar picker**: on first use (or from a settings row), let the user
  choose *which* on-device calendar (Apple / Google / Exchange) via
  `ExpoCalendar.getCalendarsAsync(EntityTypes.EVENT)`, filtered to
  `allowsModifications`. Persist the chosen `calendarId` as a client preference;
  fall back to the current default-selection logic when unset.
- **Edit propagation:** on event update, if `device_calendar_event_id` is set, call
  `ExpoCalendar.updateEventAsync(id, …)`; if the call fails (event deleted
  externally), recreate and update the stored id.
- **Delete propagation:** on event delete, if `device_calendar_event_id` is set, call
  `ExpoCalendar.deleteEventAsync(id)` (best-effort; ignore not-found).
- **Remove** `syncToGoogleCalendar()` and its "Sync to Google Calendar" UI entry.
- **Cache the device calendar list client-side** (new in v3): `getCalendarsAsync()`
  doesn't need to be called on every event save — fetch once, cache, and invalidate
  on a manual "refresh calendars" action (or a longer periodic interval) rather than
  hitting the native calendar store on every write.

### 3.2 Why this satisfies "Google or Apple, no redirect"
- iOS writes to the default EventKit calendar (Apple Calendar). If a Google account
  is attached in iOS Settings, iOS syncs it to Google automatically.
- Android writes to the Google-synced CalendarProvider calendar, so the event lands
  in Google Calendar via the OS sync adapter.
- No OAuth, no secrets, no backend, works offline. The redirect is eliminated.

### 3.3 Effort: ~2–3 days (picker UI + edit/delete propagation + 2-platform testing).
_Unchanged from v1._

## 4. Feature B — Push infrastructure for reminders

This is the core new **infrastructure**. Four layers: client registration, backend
store + scheduler + send, receipt handling, and delivery.

### 4.1 Client — push registration
- Add the `expo-notifications` **config plugin** to `app.json` (Android notification
  channel `event-reminders`; iOS `UIBackgroundModes`/APNs as needed).
- Provision credentials in EAS: **FCM** (`google-services.json`) for Android, **APNs
  key** for iOS.
- On login (and on token change), call
  `Notifications.getExpoPushTokenAsync()` and `POST /push/register`. On logout,
  `POST /push/unregister` (or mark token inactive).
- Set a foreground `setNotificationHandler` so reminders show while the app is open.
- Configure a notification **tap handler** (deep link) → open the event
  (`/event-editor?eventId=…`), and trigger voice playback if enabled (§5).

### 4.2 Backend — token store, scheduler, send

**New collection `push_tokens`:**
```
{ user_id, token, platform: "ios"|"android", updated_at, active: bool }
```
Endpoints: `POST /push/register`, `POST /push/unregister` (auth required, dedupe on
`(user_id, token)`).

**Indexes:**
- `push_tokens`: compound index on `{ user_id: 1, active: 1 }` — this is the lookup
  path executed on every reminder fire, and was missing from v1.
- `db.events`: **partial** index on `{ reminder_sent: 1, reminder_fire_at: 1 }` with
  `partialFilterExpression: { reminder_sent: false }`. Once the events collection has
  real history, the overwhelming majority of docs will have `reminder_sent: true`; a
  partial index only covers the small live/pending subset, so it stays fast and small
  regardless of total collection size. (v1 proposed a plain compound index — this is
  a drop-in swap, no query changes needed.)

**Event doc additions** (`db.events`):
- `reminder_status: "pending" | "claimed" | "sent"` (default `"pending"`) —
  idempotency guard, **replaces the plain boolean from v2** (see rationale below).
- `reminder_claimed_at: str | null` (ISO, UTC) — set when a tick claims the event;
  used to detect and recover stuck claims.
- `reminder_fire_at: str` (ISO, UTC) — denormalized `start_time - reminder_minutes`,
  computed on create/update, indexed for the scheduler query.

**Why a state machine instead of a boolean (v3 fix — this corrects a real bug in
v2):** v2 proposed "queue for batch send, then atomically set `reminder_sent: true`."
If `reminder_sent` is set to `true` *before* the send is confirmed to have actually
gone out, a network blip or Expo outage mid-call permanently loses that reminder —
it's marked done but was never delivered, and nothing will ever retry it. That's
worse than having no idempotency guard at all. The three-state version separates
"claimed so nobody else sends it" from "confirmed sent":
- Tick **atomically claims** due events (`pending` → `claimed` via a single
  `find_one_and_update` per event, matched on `reminder_status: "pending"`) — this,
  not the final state, is what prevents two overlapping ticks from double-sending.
- Only **after** the Expo API call confirms a ticket for that specific event does it
  move to `sent`.
- **Stuck-claim recovery:** each tick also queries for events where
  `reminder_status: "claimed"` and `reminder_claimed_at` is older than ~5 minutes
  (a prior tick crashed or threw mid-batch) and retries them. Without this, any
  crash between claim and send leaves that reminder stuck forever — this is the
  piece that made the boolean version fragile, and it falls out naturally once the
  states are separated.

**Past-due guard:** on create/update, if the computed `reminder_fire_at <= now`, set
`reminder_status: "sent"` immediately instead of leaving it pending. Without this,
backfilled events, imports, or edits made after an event's reminder time has already
passed will queue a reminder for something already over.

**Scheduler (Railway cron, not a persistent worker — see §10):**
- Runs on a **Railway cron schedule, once per minute**, hitting an internal
  `POST /internal/push/tick` endpoint (protected by a shared secret / internal-only
  network rule), rather than a long-running polling process. Each tick queries:
  `{ reminder_minutes: {$ne: null}, reminder_status: "pending",
     reminder_fire_at: {$lte: now} }`, plus the separate stuck-claim recovery query
  above.
- **Batch the sends, and handle partial batch results.** Group all due events'
  tokens into batches of up to 100 (Expo Push API's limit) and issue one HTTPS call
  per batch rather than one call per event. Critically, Expo's batch response
  returns **one ticket or error per item**, not a single pass/fail for the whole
  call — the tick must walk the per-item results and apply the `claimed → sent`
  transition individually. Treating the batch as all-or-nothing would either mark
  good sends as failed (because one bad token was in the same batch) or mark a
  failed send as successful.
- For each due event: look up the owner's active `push_tokens` (indexed lookup
  above), claim it (`pending → claimed`), queue for batch send, then move it to
  `sent` per-item once its ticket is confirmed. If the whole call throws (rate
  limit, transient 5xx), leave affected events in `claimed` — stuck-claim recovery
  picks them up on a later tick rather than needing separate retry/backoff logic.

**Send path:** the **Expo Push API**, batched per above (single HTTPS call per
~100 tokens, covers iOS + Android via Expo's service). Drop to raw FCM/APNs only if
richer control is later needed.

**Receipt handling (new in v2 — was missing from v1 entirely).** Expo's push flow is
two-step: a send call returns a *ticket* immediately, and the actual delivery
*receipt* (success, or an error like `DeviceNotRegistered`, `MessageRateExceeded`,
`InvalidCredentials`) is only available roughly 15+ minutes later.
- Store returned ticket ids alongside the send record (`push_receipts` collection or
  a lightweight in-memory queue keyed by tick timestamp — a small collection is
  simpler to reason about across worker restarts).
- A second cron tick, ~20 minutes after send, calls Expo's receipt endpoint for each
  outstanding ticket batch.
- On `DeviceNotRegistered`, flip that token's `active: false` in `push_tokens`
  immediately — this is the main channel by which stale tokens (app uninstalled,
  reinstalled with a new token, etc.) get pruned. Without this, dead tokens
  accumulate indefinitely and every future reminder keeps paying the send cost on
  tokens that will never succeed.
- On other errors, log for visibility (credential issues in particular should alert,
  since they mean *all* sends are silently failing).

**Reminder payload (v1, text):**
```
title: "⏰ <event title>"
body:  "Starts in <reminder label>"
data:  { eventId, kind: "event-reminder" }
```

### 4.3 Migration / edit interactions
- On event create/update: (re)compute `reminder_fire_at`; reset `reminder_status` to
  `"pending"` **only** when the fire time moves into the future (avoid re-firing past
  reminders on unrelated edits); apply the past-due guard (§4.2) if the new fire time
  is already in the past. Also clear `reminder_claimed_at` on any reset to `"pending"`.
- Clearing `reminder_minutes` clears `reminder_fire_at` (no send).

### 4.4 Local vs push reminders — resolved (was open in v1)
v1 proposed running both local and push reminders and de-duplicating "by a stable
identifier," with fully dropping local scheduling flagged as a follow-up decision.
Reliably cross-referencing an OS-generated local notification id against a
server-driven push id across iOS/Android versions is fiddly, and exactly the kind of
thing that quietly breaks on an OS update rather than failing loudly.

**Decision:** push is the source of truth. Keep local `scheduleReminder()` only as a
narrow offline safety net — schedule it **only when the reminder fire time is within
the next 2 hours** (the realistic window for "user closes the app and goes fully
offline before the push would arrive"). Do **not** attempt to suppress it against the
push arriving; accept an occasional duplicate notification as a low-cost trade-off
against building and maintaining a cross-platform dedup mechanism. This is simpler to
build, simpler to reason about when something goes wrong, and avoids a whole class of
"why did I get two reminders" bugs turning into "why did I get zero reminders" bugs.

### 4.5 Effort: ~2.5–3 weeks (plugin + creds + registration + token store +
partial index + cron scheduler + batched Expo send with per-item result handling +
claim/send state machine + stuck-claim recovery + receipt polling + dead-token
pruning + staged rollout gating + testing on a real device).
_+2–3 days versus v2, mainly for the state-machine rework and stuck-claim recovery.
This is exactly the kind of thing that's a schema decision now versus a painful
migration once real reminders are sitting in a `reminder_sent: true` boolean field
in production._

### 4.6 Staged rollout (new in v3)
Push infrastructure fails in ways that are immediately visible to users (duplicate
reminders, missing reminders, reminders at the wrong time) in a way a normal app bug
often isn't. Before enabling for everyone:
- Gate push registration behind a simple allowlist check (a config list of
  `user_id`s, or a boolean on the user doc) rather than shipping it live to all users
  on merge.
- Dogfood on your own account first for a few real events, then expand to a small
  % of users, watching the receipt-failure rate and the stuck-claim recovery query
  for anything unexpected, before removing the gate entirely.
- This is a few lines of code (a check before `/push/register` succeeds) against a
  meaningfully lower chance of a scheduler bug reaching users as a support ticket
  instead of being caught in your own testing.

## 5. Feature C — Voice reminder (tap-to-speak, opt-in)

### 5.1 Behaviour
- The push reminder **always** arrives as text (§4.2 payload).
- A **Profile setting** `voiceRemindersEnabled` (**default OFF**) gates speech.
- When ON and the user **taps** the reminder, the app opens and **speaks** the
  reminder via TTS: e.g. _"Reminder: Dentist starts in 15 minutes."_

### 5.2 Why this shape
- OS platforms don't allow autoplaying arbitrary audio from a background push (§1
  non-goals). Speaking **on tap, foregrounded** needs no special entitlement.
- Because speech is generated **on-device at tap time**, we need **no server-side
  TTS and no audio storage** in v1 — a significant complexity saving. The backend
  scheduler only ever sends text.

### 5.3 Implementation
- Add `expo-speech`. On the notification-tap handler, if `voiceRemindersEnabled`,
  build the utterance from the notification `data` (or re-fetch the event) and call
  `Speech.speak(...)`.
- Setting lives in the existing profile/settings store; **client-only** (the
  scheduler does not need it). Persist alongside other prefs.
- Respect silent mode / accessibility; provide a "Test voice" button in settings.

### 5.4 Privacy note
Event `title`/`description` are stored **plaintext** on the server (unlike notes,
which are E2EE — see `E2EE-DESIGN.md` §1 and `backend/server.py:135`). This plan does
not change that. Because voice is generated on-device, it introduces **no new
plaintext egress**. If events are ever E2EE'd, the text push body would need to move
to a client-rendered/opaque form — noted as a future fork.

### 5.5 Effort: ~2–3 days. _Unchanged from v1._

## 6. Data-model summary

| Store | Field | New? | Purpose |
|---|---|---|---|
| `db.events` | `device_calendar_event_id` | exists | native calendar round-trip |
| `db.events` | `reminder_fire_at` (ISO UTC) | **new** | scheduler query key (partial-indexed) |
| `db.events` | `reminder_status: "pending"\|"claimed"\|"sent"` | **new (v3, replaces v2's boolean)** | idempotent claim/send lifecycle |
| `db.events` | `reminder_claimed_at` (ISO UTC, nullable) | **new (v3)** | detects stuck claims for recovery |
| `push_tokens` | `user_id, token, platform, active, updated_at` | **new** | push delivery targets |
| `push_receipts` | `ticket_id, event_id, sent_at, checked: bool` | **new** | tracks tickets pending receipt check |
| client prefs | `preferredCalendarId` | **new** | chosen device calendar |
| client prefs | `voiceRemindersEnabled` (default false) | **new** | gate TTS on tap |

Indexes:
- `db.events`: **partial** index on `{ reminder_status: 1, reminder_fire_at: 1 }`,
  `partialFilterExpression: { reminder_status: "pending" }`. (Stuck-claim recovery
  queries on `reminder_status: "claimed"` separately — low enough volume that it
  doesn't need its own dedicated index, but worth revisiting if claim volume grows.)
- `push_tokens`: compound index on `{ user_id: 1, active: 1 }`.

## 7. Infrastructure / build considerations

- **Scheduler runs as Railway cron, not a persistent worker** (resolved — see §10).
  A cron-triggered endpoint hit once a minute gives the same effective behaviour as
  an always-on polling process, without paying for a container that's idle ~99% of
  the time, and it's simpler to reason about (no long-running process to babysit,
  restart, or monitor for silent death).
  ⚠️ Follow the Railway deploy rule (see project memory): backend deploys from GitHub
  source with root dir `backend` — never `railway up` from the repo root.
- **Push credentials.** FCM (`google-services.json`) + APNs key must be added to EAS
  credentials before push works on a real build.
- **Fresh dev-client/preview build required** to test push (config-plugin change) —
  use the local EAS build flow (`eas build --profile preview --local`).
- **Time zones.** Store `reminder_fire_at` in UTC; compute from the event's local
  `start_time` consistently on create/update.
- **Internal endpoint security.** The cron-triggered tick endpoint must not be
  publicly callable — gate with a shared secret header or Railway-internal networking
  so it can't be hit externally to force reminder floods or probe timing.

## 8. Deferred / optional (post-v1)

- **Tier 2 — direct Google Calendar API** (server OAuth + token storage) for
  device-independent sync (web/server-originated events). ~2 extra weeks + Google
  verification. Apple has no comparable third-party cloud API (CalDAV to iCloud is
  fragile) → would stay device-only.
- **Rich audio push** (iOS Notification Service Extension pre-downloading a TTS clip
  for instant playback on tap). ~1 week; needs a native extension.
- **Lock-screen voice autoplay** via iOS Critical Alerts entitlement — research spike;
  Apple approval is hard to obtain.
- **Multiple reminders per event** — see §10 (resolved: hold off for v1).

## 9. Phasing & estimates

| Phase | Scope | Est. |
|---|---|---|
| **1 — Calendar** | Remove redirect; calendar picker; edit/delete propagation | ~2–3 d |
| **2 — Push infra** | Config plugin + FCM/APNs creds; `/push/register`; `push_tokens` (+ index); always-on-equivalent cron scheduler; partial index on events; batched Expo send; idempotency + past-due guard; receipt polling + dead-token pruning. Ships text reminders. | ~2–2.5 wk |
| **3 — Voice toggle** | Profile setting (default off); `expo-speech`; speak-on-tap; deep link | ~2–3 d |
| **4 — optional** | Tier 2 Google API / rich audio push | see §8 |

## 10. Decisions (were open in v1, now resolved)

1. **Scheduler placement:** ~~in-process APScheduler vs separate Railway worker
   service~~ → **Railway cron hitting an internal endpoint, once per minute.** Same
   effective delivery guarantees as a persistent worker, without paying for idle
   compute, and no separate long-running process to keep alive.
2. **Keep or retire local `scheduleReminder()`:** → **keep, but narrowed** to only
   the next-2-hours window as an offline safety net; no dedup against push (§4.4).
3. **Reminder granularity (single vs multiple per event):** → **hold off.** Shipping
   multiple reminders per event touches the data model (`reminder_minutes` becomes an
   array), the scheduler query, and the idempotency guard simultaneously. Not worth
   the scope creep before push has even proven itself in production with a single
   reminder. Revisit once Phase 2 has been live for a few weeks.

## 11. Changelog (v1 → v2)

- **Added** push receipt handling (§4.2) — closes the biggest gap in v1, which had
  no way to detect dead tokens or silent send failures.
- **Added** batched sends via the Expo Push API (§4.2) instead of one call per event.
- **Changed** the events index to a partial index on `reminder_sent: false` (§4.2, §6).
- **Added** compound index on `push_tokens { user_id, active }` (§4.2, §6).
- **Added** past-due guard: `reminder_sent` set true immediately if computed
  `reminder_fire_at` is already in the past on create/update (§4.2, §4.3).
- **Resolved** the local-vs-push dedup question in favour of a narrow, non-deduped
  local fallback (§4.4).
- **Resolved** scheduler placement in favour of Railway cron over a persistent
  worker (§7, §10).
- **Resolved** to hold off on multi-reminder support for v1 (§10).
- **Updated** Phase 2 estimate from ~1.5–2 wk to ~2–2.5 wk to reflect the above.

## 12. Changelog (v2 → v3)

- **Fixed a real bug:** replaced the boolean `reminder_sent` idempotency guard with
  a `reminder_status: "pending"|"claimed"|"sent"` state machine. v2's ordering
  (mark sent, then send) could permanently lose a reminder if the send call failed
  after the flag was already set (§4.2).
- **Added** `reminder_claimed_at` + stuck-claim recovery, so a tick that crashes or
  throws mid-batch doesn't leave reminders stuck forever (§4.2).
- **Added** explicit handling of Expo's per-item batch response instead of treating
  a batch send as all-or-nothing (§4.2).
- **Removed** the need for separate retry/backoff logic on send failures — it falls
  out of the claim/recovery mechanism instead (§4.2).
- **Added** a staged rollout recommendation (dogfood → small % → full) before
  enabling push for all users (§4.6, new).
- **Added** client-side caching of the device calendar list to avoid a native call
  on every event save (§3.1).
- **Updated** the events index and data-model table to reflect the state-machine
  fields (§6).
- **Updated** Phase 2 estimate from ~2–2.5 wk to ~2.5–3 wk to reflect the
  state-machine rework and stuck-claim recovery.
