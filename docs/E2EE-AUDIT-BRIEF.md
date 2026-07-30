# Nueco E2EE — Audit Brief

Use this to commission an **independent** cryptography review. It defines scope,
the claims to verify, available test artifacts, and recommended firms.

> ⚠️ This repo also contains an **internal self-review** (§5). That is NOT an
> independent audit — it was produced by the same author (an AI assistant) that
> wrote the code, so it cannot be a security sign-off. For a security-critical
> release, engage one of the firms in §6.

## 1. Scope

- **In scope (the cryptographic core):**
  - `frontend/src/crypto/e2ee.ts` — AES-256-GCM, injected PBKDF2 KDF, DEK/KEK
    wrapping, recovery code, escrow lifecycle.
  - `frontend/src/crypto/kdf-native.ts` — native PBKDF2 wiring (react-native-quick-crypto).
  - `frontend/app/_layout.tsx` — CSPRNG polyfill + KDF wiring ordering.
  - Key handling in the app data/auth layer (Stage 3, when merged): SecureStore
    usage, in-memory key lifetime, signup/login/reset flows.
  - `backend/server.py` — `/api/crypto/wrapped-key` escrow, `enc_version`, that the
    server never receives plaintext/keys.
- **Commit/branch:** `feat/e2ee-notes` (pin the exact SHA at engagement time).
- **Out of scope:** OpenAI AI/voice egress (known, documented), metadata privacy,
  general app security (covered separately in `tests/report_security.md`).

## 2. Claims to verify

1. **Confidentiality:** note content is only ever AES-256-GCM ciphertext on the
   wire and at rest; the server/DB never receives plaintext or the DEK.
2. **Integrity:** tampered ciphertext is rejected (GCM auth); no unauthenticated modes.
3. **Key generation:** DEK and salts come from a CSPRNG on-device (polyfill active
   on Hermes; no fallback to `Math.random`).
4. **KDF:** PBKDF2-HMAC-SHA-512 (native, via quick-crypto) iteration count is
   adequate for a mobile passphrase KEK; per-use random salts; no key/salt reuse
   across purposes; KDF injection (`configureKdf`) can't be left unconfigured in prod.
5. **Nonce management:** unique random nonce per encryption; no reuse under one key.
6. **Escrow:** `wrapped_by_password` / `wrapped_by_recovery` reveal nothing about the
   DEK; recovery path correct; reset preserves the DEK without weakening it.
7. **Key lifetime:** DEK at rest only in SecureStore; not logged, not sent to
   analytics (PostHog/`feature_events`), cleared on logout.
8. **Downgrade/versioning:** `enc_version` can't be abused to force plaintext.

## 3. Specific questions for the auditor

- Is PBKDF2-HMAC-SHA-512 @ 600k iterations appropriate given the threat model and
  target devices, or should we hold out for a native Argon2id? (scrypt in pure JS
  was dropped — ~69 s/login on Hermes; native PBKDF2 @ 600k is ~350 ms; see `/crypto-check`.)
- Is single-salt-per-purpose handling correct, or should password/recovery use
  fully independent salts (current design uses separate `kdf_salt`/`recovery_salt`)?
- Is the recovery-code entropy (120 bits) and alphabet acceptable?
- Any risk from the `v1.` token format / base64 implementation (constant-time not
  required here, but confirm no parsing pitfalls)?
- Is storing the DEK in SecureStore (vs deriving per-session) the right tradeoff?

## 4. Test artifacts provided

- `cd frontend && yarn test:crypto` — 36 unit tests (round-trip, tamper, wrong
  key/password/recovery, KDF determinism, reset-preserves-DEK).
- **Cross-implementation check:** module ciphertext decrypts under Node WebCrypto
  (proves standard AES-256-GCM). Snippet in PR discussion / reproducible on request.
- **On-device:** `/crypto-check` route runs the same checks + native PBKDF2 benchmark +
  SecureStore round-trip on a real phone (APK provided).

## 5. Internal self-review (NOT independent — for context only)

Checked by the implementer against a standard checklist:
- ✅ AES-256-GCM only; no ECB/CBC; authenticated.
- ✅ 12-byte random nonce per op; uniqueness covered by test.
- ✅ 256-bit DEK from CSPRNG; native PBKDF2-HMAC-SHA-512 with per-use random salt.
- ✅ No hardcoded keys; no plaintext/keys in logs or analytics paths.
- ✅ Reset preserves DEK; old password invalidated.
- ⚠️ Open items for an auditor: PBKDF2 iteration tuning + whether to move to a
  memory-hard KDF (Argon2id) once a native module exists; consider per-purpose
  salt separation review; consider whether a long-lived DEK in SecureStore meets
  your threat model vs. session-scoped derivation; no forward secrecy.

## 6. Recommended independent reviewers

Reputable firms that do applied-crypto / mobile E2EE reviews (alphabetical):

- **Cure53** — web/mobile/crypto, fast turnarounds, publishes reports.
- **Least Authority** — specializes in cryptography / E2EE protocols.
- **NCC Group (Cryptography Services)** — large, deep crypto practice.
- **Radically Open Security** — mobile + crypto, non-profit model.
- **Trail of Bits** — applied crypto, will review primitives + key management.

**Engagement tips:** share this brief + the pinned SHA + §4 artifacts; ask for a
focused review of `e2ee.ts` + key lifecycle (typically a few engineer-days). Expect
roughly a 1–2 week, low-five-figure-USD engagement for a scope this size (varies by
firm). Request a written report you can publish.
