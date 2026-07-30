# Nueco — Event-Reminder Push: Setup Runbook

_Operational steps to turn on the Phase 2 push reminders. The code is already shipped
(`feat/push-reminders`); this is the external wiring (Firebase, EAS credentials, Railway
deploy + cron) that can't live in the repo._

There are **three independent tracks**: (A) Android FCM — needs one app rebuild, (B) the
backend deploy + secrets, (C) the two cron jobs. iOS APNs is optional (§D).

---

## A. Android FCM (the one remaining client rebuild)

The device needs Firebase config baked into the build to obtain a push token; Expo's send
service needs the FCM V1 service-account key.

1. **Firebase project + Android app**
   - https://console.firebase.google.com → create a project (or reuse one).
   - Add an **Android app** with package name **`com.riostudio.nueco`**.
   - Download **`google-services.json`**.

2. **Add it to the app** — put `google-services.json` in `frontend/`, then reference it in
   `frontend/app.json` under `expo.android`:
   ```json
   "android": {
     "package": "com.riostudio.nueco",
     "googleServicesFile": "./google-services.json"
   }
   ```
   (Don't commit `google-services.json` — add it to `.gitignore`; keep it in EAS or locally.)

3. **FCM V1 key → EAS** (server-side, for Expo to send):
   - Firebase Console → Project settings → **Service accounts** → *Generate new private key*
     → download the JSON.
   - `cd frontend && eas credentials` → Android → **Push Notifications: FCM V1** → upload that
     JSON. (Or `eas credentials -p android`.)

4. **Rebuild** — `google-services.json` is compiled into the app, so build once more:
   ```
   cd frontend && eas build --platform android --profile development --local   # dev-client, or
   cd frontend && eas build --platform android --profile production --local     # store .aab
   ```
   After this build, `getExpoPushTokenAsync()` returns a real token and registration succeeds.

---

## B. Backend deploy + secrets

The push endpoints + scheduler are in `backend/server.py` on `feat/push-reminders`.

1. **Deploy** — Railway deploys from the GitHub source (root dir `backend`). Merge
   `feat/push-reminders` → `main` (or point Railway at the branch) to trigger a redeploy.
   > ⚠️ Never `railway up` from the repo root — it builds the stray root `package.json` as a
   > Node app and 502s. Deploy from source (root dir = `backend`).

2. **Env vars** (Railway → backend service → Variables):
   - `PUSH_TICK_SECRET` = a long random string (shared with the cron jobs). **Required** —
     without it the `/internal/push/*` endpoints return 403.
   - `EXPO_ACCESS_TOKEN` = *(optional)* an Expo access token (expo.dev → Account → Access
     Tokens) to authenticate sends. Recommended but not required.

3. **Verify** the endpoints exist after deploy:
   ```
   curl -s -o /dev/null -w "%{http_code}\n" https://web-production-a3258.up.railway.app/api/internal/push/tick
   # expect 403 (secret missing) — proves the route is live
   curl -s -o /dev/null -w "%{http_code}\n" -X POST \
     -H "X-Tick-Secret: <PUSH_TICK_SECRET>" \
     https://web-production-a3258.up.railway.app/api/internal/push/tick
   # expect 200 {"claimed":0,"sent":0} when nothing is due
   ```

---

## C. Cron jobs (the scheduler)

Two scheduled POSTs, each sending the shared secret header. Per the design (§10) these run on
**Railway cron**, but any minute-capable scheduler works (a Railway cron service, an external
minute-cron, etc. — note GitHub Actions can't go below 5-min intervals, too coarse for the tick).

| Job | Endpoint | Schedule |
|---|---|---|
| Fire reminders | `POST /api/internal/push/tick` | `* * * * *` (every minute) |
| Resolve receipts | `POST /api/internal/push/receipts` | `*/20 * * * *` (~every 20 min) |

**Railway cron service** — add a service whose cron schedule is set in Settings and whose start
command is one of:
```
curl -fsS -X POST -H "X-Tick-Secret: $PUSH_TICK_SECRET" \
  https://web-production-a3258.up.railway.app/api/internal/push/tick
```
```
curl -fsS -X POST -H "X-Tick-Secret: $PUSH_TICK_SECRET" \
  https://web-production-a3258.up.railway.app/api/internal/push/receipts
```
(Set `PUSH_TICK_SECRET` on the cron service too, matching the backend.)

---

## D. iOS APNs (optional — only if shipping to iOS)

- `eas credentials -p ios` → **Push Notifications** → let EAS create/upload an APNs key.
- Rebuild iOS. No backend change (Expo relays APNs the same way as FCM).

---

## E. End-to-end verification

1. Fresh build installed (§A step 4), logged in → the app registers a token
   (`POST /api/internal/... register`; check the `push_tokens` collection has an `active: true`
   row for your user).
2. Create an event with a reminder a couple minutes out.
3. Within a minute of the fire time, the tick sends it → the phone shows
   **"⏰ <title> — Starts in <label>"**. Tapping opens the event.
4. ~15–20 min later the receipts job resolves tickets; a `DeviceNotRegistered` result flips that
   token `active: false`.

## What needs a rebuild vs not (summary)
- **Rebuild:** only §A (embedding `google-services.json`). Fold Phase 3's `expo-speech` into the
  same rebuild if doing them together.
- **No rebuild:** §B backend deploy, §B env vars, §C cron. All server/infra-side.
