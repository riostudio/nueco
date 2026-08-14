# Data Residency Gaps — What Code Cannot Fix

Ordered, **blockers first**. A "blocker" means no Australian-residency claim can be made until it
is resolved. Every item needs a console change, vendor action, contract, or migration — not code.
Region facts marked UNVERIFIED were not provable from code or from vendor documentation we hold;
do not assert them to buyers until confirmed in writing from the vendor.

---

## BLOCKERS

### 1. OpenAI processing location (raw audio + plaintext note text)
- **What:** Whisper transcription and `gpt-4o-mini` features send the app's most sensitive
  payloads (voice recordings, note contents, transcripts, feedback text) to OpenAI.
- **Action:** Confirm from OpenAI's current documentation whether any Australian (or
  region-pinned) processing option exists for your API tier. If not, choose one: (a) execute a
  DPA and disclose offshore processing, (b) move LLM workloads to a provider offering AU regions
  (e.g. Azure OpenAI in Australia East — UNVERIFIED, confirm), or (c) make AI features opt-in per
  user with explicit offshore disclosure.
- **Risk if unresolved:** sensitive health information is processed offshore with no residency
  basis — the single largest exposure in the audit. Until resolved, the `OPENAI_REGION=au`
  boot declaration is an attestation, not a fact.

### 2. Railway deployment region
- **What:** The entire FastAPI backend (all API processing, platform logs including user email
  addresses) runs on Railway at `web-production-a3258.up.railway.app`. Region unknown.
- **Action:** Railway console → service settings → confirm region. If not Australia, redeploy to
  an AU region if Railway offers one for your plan (UNVERIFIED — confirm plan capability), or
  migrate hosting. This is also where backend logs live.
- **Risk if unresolved:** every API call, plus logs containing user emails, may be processed and
  stored offshore regardless of every other control.

### 3. MongoDB Atlas cluster region
- **What:** All persisted data (accounts, E2EE ciphertext, **plaintext feedback**, push tokens,
  shadow transcripts) lives in Atlas. Region unknown.
- **Action:** Atlas console → cluster → confirm region. If not Australia, migrate the cluster
  (live migration or export/import) to an AU region and update `MONGO_URL` + set
  `MONGODB_REGION` accordingly.
- **Risk if unresolved:** the system of record is offshore; feedback text and operational
  metadata are readable plaintext offshore even though note content is ciphertext.

### 4. AWS S3 bucket region
- **What:** Attachment ciphertext is stored in S3. Code previously defaulted to `us-east-1`;
  the actual bucket region is unknown.
- **Action:** AWS console → S3 → confirm bucket region. If not `ap-southeast-2` (or another AU
  region), create an AU bucket, migrate objects, and update `S3_BUCKET`/`AWS_REGION`.
- **Risk if unresolved:** attachment blobs stored in the US. Mitigating factor: blobs are E2EE
  ciphertext — exposure is metadata (sizes, timing), not content.

### 5. Speechmatics processing location
- **What:** When enabled, raw audio (including diarized conversations) uploads to Speechmatics.
  Jobs are deleted after completion, but processing location is unknown.
- **Action:** Confirm from Speechmatics' current documentation which region the batch API
  endpoint serves and whether an AU option exists. Execute a DPA. If no AU option, gate the
  provider behind the same disclosure/opt-in decision as OpenAI.
- **Risk if unresolved:** raw voice recordings — biometric-adjacent data — processed offshore.

---

## HIGH (contracts and console work)

### 6. PostHog analytics region (device + backend flag polling)
- **What:** PostHog is configured to `https://us.i.posthog.com` in every eas.json profile
  (device) and polled by the backend for feature flags. Analytics are opt-in and content-free,
  but device metadata and a partial user id go to the US.
- **Action:** Decide: keep US with disclosure; move the project to PostHog EU (requires a
  PostHog console change + `EXPO_PUBLIC_POSTHOG_HOST` change in eas.json + rebuild — no AU
  region is known to exist, UNVERIFIED); or self-host PostHog in AU (infrastructure change).
  Execute a DPA either way.
- **Risk if unresolved:** telemetry leaves Australia by default configuration. Lower sensitivity
  (no content), but it is the easiest buyer question to fumble because the US host is baked into
  build config.

### 7. Expo push service
- **What:** Reminder notifications (push token + payload; legacy events carry plaintext titles)
  transit Expo's servers, then FCM (Google) for delivery.
- **Action:** Confirm Expo's processing location (UNVERIFIED) and execute a DPA. If
  unacceptable, the alternative is direct FCM integration — still Google infrastructure, so this
  may be irreducible; document it as a disclosed subprocessor. Separately, plan to retire
  plaintext titles by completing E2EE migration of legacy events.
- **Risk if unresolved:** notification metadata (timing, some titles) processed offshore by two
  chained third parties.

### 8. Resend transactional email
- **What:** Verification/reset emails send recipient email + name + auth tokens to Resend.
- **Action:** Confirm Resend's processing/storage region (UNVERIFIED) and execute a DPA. If no
  AU option, evaluate AU-hosted transactional email providers.
- **Risk if unresolved:** PII and live auth tokens processed offshore.

### 9. DPAs across the chain
- **What:** No code control substitutes for contracts.
- **Action:** Execute Data Processing Agreements with: Railway, MongoDB Atlas, AWS, OpenAI,
  Speechmatics, PostHog, Expo, Resend, Google (Calendar API), Canva, Open-Meteo. Record each
  vendor's stated processing region in your vendor register alongside `docs/data-flow.md`.
- **Risk if unresolved:** APP 11 / APP 8 exposure even where technical controls are perfect.

---

## MEDIUM (disclosure or product decisions)

### 10. Google Calendar sync (user-elected)
- Global Google infrastructure; user connects explicitly and tokens stay on-device. **Action:**
  disclose as a user-elected integration in the privacy policy; no residency claim possible.
  **Risk:** low (consent-based), but buyers will ask — have the answer rehearsed.

### 11. Open-Meteo weather
- Device GPS coordinates are sent for Daily Brew weather. **Action:** confirm vendor location
  (UNVERIFIED) or proxy through your own backend so coordinates never leave your infrastructure.
  **Risk:** precise location is sensitive; currently disclosed nowhere.

### 12. Canva integration
- OAuth tokens and design metadata via Canva's global API. **Action:** DPA + disclosure.
  **Risk:** low sensitivity; still must be in the vendor register.

### 13. Platform-level services (unfixable by any code)
- OS geocoder (Google Play services), Google Play / App Store review prompts, FCM transport.
  **Action:** document as platform-inherent disclosures. **Risk:** unavoidable; auditors accept
  documented platform flows.

### 14. Frontend endpoint configuration is build-time, not runtime-enforced
- The Phase 3 fail-closed gate covers the **backend**. The app binary still carries
  `EXPO_PUBLIC_POSTHOG_HOST=us.i.posthog.com` in every eas.json profile and a hardcoded backend
  origin fallback (`frontend/src/backendBaseUrl.ts:1`). **Action:** when vendor decisions above
  land, update eas.json values and remove the fallbacks (small code task), then rebuild — the
  running app cannot be reconfigured otherwise. **Risk:** the app keeps phoning the US even after
  the backend is fully AU-compliant.

---

## Notes

- The Phase 3 boot gate (`backend/core/regions.py`) enforces that every service has an explicit
  endpoint + AU region declaration before the server starts. It proves configuration intent; it
  cannot prove vendor reality. Items 1-8 are that reality gap.
- Device-side plaintext findings (local working set, transcripts, export file, decrypted
  attachment caches, data surviving logout) are **fixable in code** and are tracked separately as
  remediation work, not residency gaps.
