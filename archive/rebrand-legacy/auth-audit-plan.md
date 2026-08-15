# Nueco: authentication audit and biometric plan

Audit first, biometric second. Biometric gates local access to a stored credential. If that credential is stored insecurely or the API has authorization gaps, biometric adds nothing but the appearance of security.

Stack: React Native / Expo client, FastAPI on Railway, MongoDB Atlas, RevenueCat.

---

## Threat model

Be explicit about what this is defending against, so effort goes to the right place.

**In scope:**
1. Someone picks up an unlocked device and reads notes
2. A user reads or modifies another user's notes via the API (IDOR)
3. Token extracted from device storage or a device backup
4. Credentials leaked through logs or error reporting

**Out of scope at current stage:**
- Nation-state adversaries
- Sophisticated reverse engineering of the APK
- Certificate pinning bypass

Design for the first four. Do not spend time on the rest.

---

## Phase 0: Inventory

Write down the current state before changing anything.

- [ ] What is the auth mechanism? Email/password, magic link, Google Sign-In, something else
- [ ] Where are access and refresh tokens stored on the client?
- [ ] What are the token lifetimes?
- [ ] How many endpoints exist, and which require auth?
- [ ] Is there a password reset flow? A password change flow?
- [ ] Is there an account deletion flow?
- [ ] How does RevenueCat identify the user?

**Done when:** you can draw the full auth flow from login to token refresh to logout on one page.

---

## Phase 1: Client token storage

Highest likelihood of a real finding.

- [ ] Confirm tokens are in `expo-secure-store`, backed by Android Keystore. **AsyncStorage is not acceptable.** It is plaintext, readable on rooted devices, and included in device backups
- [ ] If tokens are currently in AsyncStorage: migrate, then explicitly clear the old AsyncStorage keys on next launch
- [ ] Set `android:allowBackup="false"` or configure backup rules to exclude auth data
- [ ] Grep the codebase for tokens in `console.log`
- [ ] Confirm tokens are not attached to Sentry breadcrumbs, crash reports, or analytics events
- [ ] Confirm tokens never appear in URL query strings, only in the Authorization header

**Done when:** a device backup extraction yields no usable credential.

---

## Phase 2: Token lifecycle

- [ ] Access token lifetime is short (15 to 60 minutes)
- [ ] Refresh token is separate, longer lived, and rotated on every use
- [ ] Refresh token reuse detection: if an already-used refresh token is presented, revoke the whole family and force re-login. This is how you detect a stolen token
- [ ] Refresh happens transparently on 401 without logging the user out
- [ ] Concurrent request handling: several requests hitting 401 at once should trigger one refresh, not five

---

## Phase 3: Server-side verification and authorization

**This phase matters more than everything else combined.**

### JWT verification

- [ ] Confirm the token is verified, not just decoded. `jwt.decode(token, options={"verify_signature": False})` anywhere is a critical finding
- [ ] Algorithm is pinned explicitly. Reject `none`. Do not accept an algorithm supplied by the token header
- [ ] Expiry (`exp`) is actually checked
- [ ] Signing secret is in Railway environment variables, not in code
- [ ] Check git history for a previously committed secret. If found, rotate it

### Authorization (IDOR)

The most likely serious vulnerability in an app like this.

- [ ] Every note endpoint must verify the note belongs to the requesting user, not merely that the token is valid
- [ ] Audit: `GET /notes/{id}`, `PATCH /notes/{id}`, `DELETE /notes/{id}`, `POST /notes/bulk-delete`, `POST /notes/bulk-tag`, export endpoints
- [ ] Ownership check belongs in the query filter, not in application logic after the fetch. `find_one({"_id": id, "user_id": current_user})`, never `find_one({"_id": id})` followed by a comparison
- [ ] Write a test that authenticates as user A and attempts to read, edit and delete a note belonging to user B. All three must fail with 404, not 403 (404 avoids confirming the id exists)

### Endpoint hygiene

- [ ] Auth is applied by default with explicit opt-out, rather than opt-in per route. Opt-in means a forgotten decorator is an open endpoint
- [ ] Rate limit login, password reset and refresh endpoints
- [ ] Generic error messages on login. Do not reveal whether an email exists
- [ ] Confirm HTTPS only. `android:usesCleartextTraffic="false"` in the manifest

**Done when:** the cross-user access test suite passes and no endpoint decodes a token without verifying it.

---

## Phase 4: Session management and deletion

- [ ] Logout clears client secure storage **and** revokes the refresh token server-side
- [ ] Uninstall and reinstall results in a clean state, not a resurrected session
- [ ] Password change revokes all existing refresh tokens
- [ ] **Account deletion.** Google Play requires an in-app deletion path plus a web link for apps that allow account creation. Deactivation alone does not comply
  - [ ] In-app "Delete account" in Settings
  - [ ] Hosted web deletion page linked from the app and the Play listing
  - [ ] Deletion removes account data, not just flags it
  - [ ] Data safety form in Play Console updated to match reality
  - [ ] Privacy policy describes the deletion process

---

## Phase 5: RevenueCat identity

Easy to get wrong and it leaks across users on shared devices.

- [ ] Confirm `logIn()` is called with your stable app user id on login, not left anonymous
- [ ] Confirm `logOut()` is called on logout so subscription state does not carry to the next user on the device
- [ ] Entitlement checks are validated server-side for anything that gates real data, not trusted from the client alone
- [ ] Account deletion handles the RevenueCat subscriber record

---

## Phase 6: Biometric

Only after Phases 1 through 3 are clean.

### What it does

Biometric gates local access to the already-stored refresh token. It does not authenticate to the server. Name and describe it accordingly.

### Implementation

- [ ] `expo-local-authentication` for the prompt
- [ ] Check `hasHardwareAsync()` and `isEnrolledAsync()` before offering the feature. Many budget Android devices have neither
- [ ] Device PIN or pattern fallback is mandatory. Biometric-only locks users out
- [ ] Biometric is never the only path to the account. Email login must always work as recovery, or a lost device means a lost account
- [ ] Re-prompt after the app has been backgrounded more than 60 seconds. Make the threshold configurable
- [ ] Handle enrolled-biometric changes. Android Keystore can invalidate keys when a new fingerprint is added. Decide whether that forces re-login or silently falls back to PIN
- [ ] Setting to turn it off, requiring auth to change

### Where it applies

- [ ] App open (optional setting, off by default)
- [ ] Viewing locked notes (see `features-multiselect-export-lock.md`)
- [ ] Export of locked notes
- [ ] Account deletion confirmation

---

## Triage

Fix in this order regardless of what else is on the roadmap.

| Priority | Finding | Why |
|---|---|---|
| Critical | Missing ownership checks on note endpoints | Cross-user data access |
| Critical | Token decoded without signature verification | Full auth bypass |
| Critical | Secret committed to git history | Forgeable tokens |
| High | Tokens in AsyncStorage | Plaintext credential on device |
| High | No account deletion path | Play policy enforcement risk |
| Medium | No refresh rotation or reuse detection | Stolen tokens live indefinitely |
| Medium | No rate limiting on auth endpoints | Credential stuffing |
| Low | Biometric gate | UX and trust, not a security fix |

---

## Out of scope

- Certificate pinning
- Device attestation / Play Integrity API
- Multi-factor authentication
- APK obfuscation

Revisit if the user base or the sensitivity of stored data changes materially.
