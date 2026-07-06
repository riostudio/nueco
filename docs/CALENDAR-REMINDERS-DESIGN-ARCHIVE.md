# MemoPad — Calendar Sync & Event-Reminder Push Infrastructure

_Status: **planned** (not yet implemented). This doc is the implementation plan for
two related features: (1) native Google/Apple calendar sync without a browser
redirect, and (2) server-driven push notifications for event reminders, with an
optional spoken ("voice") reminder._

_Decisions locked with the product owner (2026-07-05):_
- _Calendar sync: **device-calendar only** (reuse `expo-calendar`), no server-side
  Google/Apple OAuth in v1._
- _Voice reminder: **tap-to-speak**, gated by a Profile setting, **default OFF**._

## 1. Goals

1. A user can **create or link** an event in MemoPad and have it **auto-sync to the
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
  event id; we do not import external calendar changes back into MemoPad.

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

### 3.2 Why this satisfies "Google or Apple, no redirect"
- iOS writes to the default EventKit calendar (Apple Calendar). If a Google account
  is attached in iOS Settings, iOS syncs it to Google automatically.
- Android writes to the Google-synced CalendarProvider calendar, so the event lands
  in Google Calendar via the OS sync adapter.
- No OAuth, no secrets, no backend, works offline. The redirect is eliminated.

### 3.3 Effort: ~2–3 days (picker UI + edit/delete propagation + 2-platform testing).

## 4. Feature B — Push infrastructure for reminders

This is the core new **infrastructure**. Three layers: client registration, backend
store + scheduler + send, and delivery.

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

**Event doc additions** (`db.events`):
- `reminder_sent: bool` (default false) — idempotency guard so a reminder fires once.
- `reminder_fire_at: str` (ISO, UTC) — denormalized `start_time - reminder_minutes`,
  computed on create/update, indexed for the scheduler query.

**Scheduler (the always-on worker):**
- A worker loops every ~30–60 s and queries:
  `{ reminder_minutes: {$ne: null}, reminder_sent: false,
     reminder_fire_at: {$lte: now} }`.
- For each due event: look up the owner's active `push_tokens`, send via the Expo
  Push API, then atomically set `reminder_sent: true`
  (`find_one_and_update` guard so concurrent workers don't double-send).
- Implementation: APScheduler inside FastAPI **or** a small separate Railway worker
  service. **Must be always-on** — see §7 (Railway sleeps idle web dynos, and a
  request-driven web process cannot fire minute-accurate reminders).

**Send path:** the **Expo Push API** (single HTTPS call, covers iOS + Android via
Expo's service). Drop to raw FCM/APNs only if richer control is later needed.

**Reminder payload (v1, text):**
```
title: "⏰ <event title>"
body:  "Starts in <reminder label>"
data:  { eventId, kind: "event-reminder" }
```

### 4.3 Migration / edit interactions
- On event create/update: (re)compute `reminder_fire_at`; reset `reminder_sent` to
  false **only** when the fire time moves into the future (avoid re-firing past
  reminders on unrelated edits).
- Clearing `reminder_minutes` clears `reminder_fire_at` (no send).

### 4.4 Local vs push reminders
Keep the existing **local** `scheduleReminder()` as a belt-and-suspenders fallback
(fires even fully offline), and de-duplicate: if the push handler and a local
notification would both fire, prefer the push and cancel the matching local one by a
stable identifier. (Alternatively, drop local scheduling once push is proven — a
follow-up decision.)

### 4.5 Effort: ~1.5–2 weeks (plugin + creds + registration + token store +
scheduler + Expo send + idempotency + testing on a real device).

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

### 5.5 Effort: ~2–3 days.

## 6. Data-model summary

| Store | Field | New? | Purpose |
|---|---|---|---|
| `db.events` | `device_calendar_event_id` | exists | native calendar round-trip |
| `db.events` | `reminder_fire_at` (ISO UTC) | **new** | scheduler query key (indexed) |
| `db.events` | `reminder_sent` (bool) | **new** | fire-once idempotency |
| `push_tokens` | `user_id, token, platform, active, updated_at` | **new** | push delivery targets |
| client prefs | `preferredCalendarId` | **new** | chosen device calendar |
| client prefs | `voiceRemindersEnabled` (default false) | **new** | gate TTS on tap |

New index: `db.events` on `{ reminder_sent: 1, reminder_fire_at: 1 }`.

## 7. Infrastructure / build considerations

- **Always-on scheduler.** Railway must run the reminder worker as a persistent
  process (separate service or in-process APScheduler on a non-sleeping dyno). A
  purely request-driven web process will miss reminders.
  ⚠️ Follow the Railway deploy rule (see project memory): backend deploys from GitHub
  source with root dir `backend` — never `railway up` from the repo root.
- **Push credentials.** FCM (`google-services.json`) + APNs key must be added to EAS
  credentials before push works on a real build.
- **Fresh dev-client/preview build required** to test push (config-plugin change) —
  use the local EAS build flow (`eas build --profile preview --local`).
- **Time zones.** Store `reminder_fire_at` in UTC; compute from the event's local
  `start_time` consistently on create/update.

## 8. Deferred / optional (post-v1)

- **Tier 2 — direct Google Calendar API** (server OAuth + token storage) for
  device-independent sync (web/server-originated events). ~2 extra weeks + Google
  verification. Apple has no comparable third-party cloud API (CalDAV to iCloud is
  fragile) → would stay device-only.
- **Rich audio push** (iOS Notification Service Extension pre-downloading a TTS clip
  for instant playback on tap). ~1 week; needs a native extension.
- **Lock-screen voice autoplay** via iOS Critical Alerts entitlement — research spike;
  Apple approval is hard to obtain.

## 9. Phasing & estimates

| Phase | Scope | Est. |
|---|---|---|
| **1 — Calendar** | Remove redirect; calendar picker; edit/delete propagation | ~2–3 d |
| **2 — Push infra** | Config plugin + FCM/APNs creds; `/push/register`; `push_tokens`; always-on scheduler; Expo send; idempotency. Ships text reminders. | ~1.5–2 wk |
| **3 — Voice toggle** | Profile setting (default off); `expo-speech`; speak-on-tap; deep link | ~2–3 d |
| **4 — optional** | Tier 2 Google API / rich audio push | see §8 |

## 10. Open decisions

1. **Scheduler placement:** in-process APScheduler vs separate Railway worker
   service. (Leaning: separate worker for isolation + guaranteed always-on.)
2. **Keep or retire local `scheduleReminder()`** once push is proven (§4.4).
3. **Reminder granularity:** single `reminder_minutes` per event today — keep, or
   support multiple reminders per event?
