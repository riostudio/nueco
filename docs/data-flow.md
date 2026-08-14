# Data Flow & Residency Map

**Audience:** enterprise buyers, auditors, and engineers. **Scope:** every point where data leaves
the Android device or the Nueco backend, and everything that persists on the device.
**Sources:** read-only code audit (2026-08-14) of `frontend/` (Expo SDK 55) and `backend/`
(FastAPI on Railway), plus the generated architecture wikis at
`frontend/.qoder/repowiki/en/` and `backend/.qoder/repowiki/en/`.

**Region column convention:** `UNVERIFIED` means the code does not prove the region and it must be
confirmed in the vendor's console/docs. We deliberately do not assert vendor regional capabilities
from hostnames alone. After the Phase 3 refactor, every backend endpoint is set by an explicit
environment variable validated at boot (`backend/core/regions.py`); the "configured by" column
names that variable.

---

## 1. Device → Nueco backend (Railway)

All rows use `{BACKEND_API_BASE_URL}` = `https://web-production-a3258.up.railway.app/api`
(hardcoded default at `frontend/src/backendBaseUrl.ts:1`, override `EXPO_PUBLIC_BACKEND_URL`,
not set in any eas.json profile). **Railway deployment region: UNVERIFIED — console check.**

| What | Data class | Code | Encrypted in transit / at server |
|---|---|---|---|
| Notes, events, trips sync | derived note (E2EE ciphertext) + auth token | `frontend/src/api.ts:143-219` | TLS; stays ciphertext in MongoDB |
| Voice transcription upload | **raw audio (base64)** + auth token | `frontend/src/api.ts:386-405` → `/api/transcribe-base64` | TLS; backend forwards to STT provider |
| Text processing (organize/summarize/format) | **plaintext note text** | `frontend/src/api.ts:439-446` → `/api/process-text` | TLS; forwarded to LLM |
| Voice intent classification | **plaintext transcript** + timezone | `frontend/src/api.ts:469-476` → `/api/classify-voice-intent` | TLS; forwarded to LLM |
| Signup / login / password flows | **participant PII** (email, name, password) + device info | `frontend/src/auth/api/authApi.ts:56-236` | TLS; bcrypt at rest |
| Push token registration | push token + platform | `frontend/src/api.ts:229-232` | TLS |
| In-app feedback | free text + device info | `frontend/src/api.ts:243` | TLS; **stored plaintext in MongoDB** |
| Attachment presign/download | file metadata (name/type/size) | `frontend/src/api.ts:259-268` | TLS; blob itself goes direct to S3 (E2EE ciphertext) |
| E2EE wrapped-key escrow | opaque key blobs | `frontend/src/crypto/escrowApi.ts:22-32` | TLS; server cannot unwrap |
| Daily Brew news preferences | country code, outlet picks | `frontend/src/api.ts:529-557` | TLS |

**Buyer paragraph:** *"The app syncs notes, events and trips to our API end-to-end encrypted —
the server stores ciphertext it cannot read. Voice recordings are uploaded over TLS for
transcription, and note text is sent to our API for AI formatting/summarisation; those two
features require plaintext processing and are the main scope items for subprocessors below.
Account signup sends name, email and password (hashed at rest). We also store free-text feedback
and push tokens. The API is hosted on Railway; the deployment region is being confirmed."*

## 2. Device → third parties directly

| What | Data class | Vendor / endpoint | Configured by | Region |
|---|---|---|---|---|
| Usage analytics (opt-in only) | telemetry + device info | PostHog `https://us.i.posthog.com` | `EXPO_PUBLIC_POSTHOG_HOST` (eas.json, all profiles) + code fallback `frontend/src/analytics/posthog.ts:35` | hostname indicates US; formal confirmation UNVERIFIED |
| Google Calendar sync | **plaintext event data — participant PII** + Google token | Google `www.googleapis.com/calendar/v3`, `oauth2.googleapis.com`, `accounts.google.com` | hardcoded `frontend/src/google/calendarApi.ts:8`, `auth.ts:40-41,111` | UNVERIFIED (global) |
| Weather for Daily Brew | **precise GPS coordinates** | Open-Meteo `api.open-meteo.com/v1/forecast` | hardcoded `frontend/src/dailyBrew/dailyBrew.ts:159` | UNVERIFIED |
| Link unfurling (shared URLs) | the shared URL itself | TikTok `www.tiktok.com/oembed`, Reddit `www.reddit.com/*.json`, **arbitrary hosts** (OG scrape) | hardcoded `frontend/src/share/unfurl.ts:66-149` | UNVERIFIED |
| Image/news thumbnails | device IP | YouTube `i.ytimg.com`, news-outlet CDNs, arbitrary | data-dependent | UNVERIFIED |
| Expo push token request | device info | Expo push service (SDK default, no URL in code) | SDK `frontend/src/notifications.ts:88-92` | UNVERIFIED |
| Attachment upload/download | attachment **ciphertext** | AWS S3 via presigned URLs (host from backend) | server response | bucket region UNVERIFIED |
| Reverse geocoding | coordinates | OS geocoder (Google Play services on Android) | OS API | UNVERIFIED |

**Buyer paragraph:** *"With a user's explicit choice, the device talks directly to Google
(calendar sync), Open-Meteo (weather, using device location), PostHog (usage analytics, off by
default and opt-in only), and link-preview services for content the user shares into the app.
Google sign-in tokens stay on the device; our server never sees them. Analytics collect feature
counts and durations only — never note content — and can be revoked in Settings."*

## 3. Backend → third parties

After Phase 3, every endpoint below is env-configured and validated at boot by
`backend/core/regions.py` (fail-closed; missing or non-AU declaration = no boot).

| What | Data class | Vendor / endpoint | Configured by | Region |
|---|---|---|---|---|
| All persisted app data | accounts, E2EE ciphertext, feedback plaintext, push tokens, shadow transcripts | MongoDB Atlas | `MONGO_URL` + `MONGODB_REGION` | **UNVERIFIED — Atlas console** |
| Speech-to-text (default provider) | **raw audio** | OpenAI Whisper (`whisper-1`) | `OPENAI_BASE_URL` + `OPENAI_REGION` | UNVERIFIED |
| AI text features + feedback triage | **plaintext note text / transcripts / feedback** (`gpt-4o-mini`) | OpenAI | as above | UNVERIFIED |
| Speech-to-text (alternate provider, speaker diarization) | **raw audio**; job deleted after completion + 10-min sweeper | Speechmatics batch API | `SPEECHMATICS_BASE_URL` + `SPEECHMATICS_REGION` | UNVERIFIED |
| Push delivery | push token + payload; **plaintext event title for legacy non-E2EE events** | Expo push `exp.host/--/api/v2/push/*` | `EXPO_PUSH_SEND_URL` / `EXPO_PUSH_RECEIPTS_URL` + `EXPO_PUSH_REGION` | UNVERIFIED |
| Transactional email (verify/reset) | **PII** (email + name) + **auth tokens** in links | Resend | `RESEND_BASE_URL` + `RESEND_REGION` | UNVERIFIED |
| Attachment storage | attachment ciphertext (presigned POST/GET) | AWS S3 | `S3_BUCKET` + `AWS_REGION` | bucket region UNVERIFIED — console |
| Feature-flag polling | none (static id, no user data) | PostHog `/decide` | `POSTHOG_HOST` + `POSTHOG_REGION` | as above |
| Canva import | OAuth tokens, design IDs | Canva `www.canva.com`, `api.canva.com` | `CANVA_*_URL` + `CANVA_REGION` | UNVERIFIED |
| Daily Brew RSS fetching | none (plain GET; user custom feeds SSRF-guarded) | 32 curated outlets + arbitrary user feeds | hardcoded catalog `backend/dailybrew/catalog.py` | n/a |
| Platform logs | operational logs **incl. user email addresses in auth logs** | Railway log capture | platform default | Railway region UNVERIFIED |

**Buyer paragraph:** *"Our server stores data in MongoDB Atlas and files in AWS S3 (both
encrypted at rest; note/event content is additionally E2EE ciphertext). For AI features we send
recordings and note text to OpenAI, with Speechmatics as an alternative speech provider that adds
speaker separation; transcription jobs are deleted after completion. Reminder push notifications
go via Expo's push service, and transactional email via Resend. Every one of these endpoints is
now set by explicit environment configuration, and the server refuses to boot unless each is
declared with an Australian-region attestation. We are confirming each vendor's actual processing
location and putting DPAs in place — see residency-gaps.md."*

## 4. What persists on the Android device

| Store | Data | Encrypted at rest | Deleted when | Survives logout | Survives uninstall |
|---|---|---|---|---|---|
| `nueco/recordings/*.m4a` | **raw audio** | **No** | retention sweep (default 30 days; conversation mode hard-capped 24 h; immediate option) | **Yes** | No |
| `nueco/recordings.json` | **full transcripts + speaker labels** | **No** | with the recording | **Yes** | No |
| `nueco/notes|events|trips|syncQueue.json` | **plaintext notes/events/trips + pending writes** | **No (by design — E2EE applies to transport/server, not the local working set)** | only on account deletion | **Yes** | No |
| SecureStore `e2ee_dek_v1` | E2EE data key | Yes (Android Keystore-backed) | logout | No | No |
| AsyncStorage **+** SecureStore `access_token`/`refresh_token` | auth tokens | **plaintext AsyncStorage copy is the operative one** | logout | No | No |
| SecureStore `google_oauth_tokens` | Google tokens | Yes | explicit disconnect only | **Yes** | No |
| AsyncStorage `google_sync_retry_queue` | **full plaintext events** | No | explicit disconnect only | **Yes** | No |
| AsyncStorage `calendar_sync_event_hashes` | **verbatim event title/location/notes** (not actually hashed) | No | logout | No | No |
| `nueco-export-*.json` | **full plaintext GDPR export** | **No** | **never — no deletion in code** | **Yes** | No |
| `cacheDirectory` temp files | share images/PDFs, **decrypted attachment copies**, transcript exports | **No** | never in code — OS cache eviction only | **Yes** | No |
| OS device calendar | event title/description/location — **outside the app sandbox** | No | on event edit only | **Yes** | **Yes (and syncs to the user's calendar accounts)** |
| Scheduled local notifications | payload embeds event title | No | reschedule/cancel | Yes | OS-defined |
| Voice-onboarding capture | raw audio in expo-audio cache | No | **no retention sweep applies** | Yes | No |
| AsyncStorage flags/prefs/consent log | preferences, attestation records | No | mostly never | Yes | No |

**Buyer paragraph:** *"On the device, the working set (notes, events, recordings, transcripts) is
stored in plaintext inside the app sandbox so the app works offline; it is removed by the OS on
uninstall. The encryption key and account session are wiped on logout, but content files remain
until account deletion — this is the audit's top device-side remediation item. Voice recordings
self-destruct on a user-controlled schedule (30 days by default, 24 hours for conversation
mode). Events optionally written to the device calendar live outside our sandbox and follow the
user's own calendar accounts."*

## 5. Verified absent

No RevenueCat, Sentry, Firebase SDK, Crashlytics, Amplitude, Mixpanel, Segment, Bugsnag, Datadog,
expo-updates/OTA, websockets, or axios anywhere in app or backend code. Push uses Expo's service
with FCM wired via EAS credentials (no Firebase SDK in the binary).

## 6. Supporting architecture references (generated wiki)

- Backend: `backend/.qoder/repowiki/en/content/Core Architecture/Region Validation & Data Residency.md`,
  `.../AI Services/External API Integration/`, `.../Deployment & Operations/Environment Configuration.md`
- Frontend: `frontend/.qoder/repowiki/en/content/Architecture & Design/Data Flow Patterns/`,
  `.../Offline & Synchronization/Local Storage & Data Persistence.md`
