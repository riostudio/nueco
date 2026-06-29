# MemoPad — End-to-End Encryption Design & Threat Model

_Status: implemented (crypto core + backend escrow); app wiring/migration pending._
_Scope of this doc: the cryptographic design that an external auditor should review._

## 1. Goal

Note content (`title`, `content`, `tags`, and structured fields) is encrypted on
the user's device so that **the server, the operator, MongoDB Atlas, and anyone with
a database dump cannot read it**. The server stores only ciphertext and opaque
wrapped-key material.

### Non-goals (explicitly out of scope)
- **Metadata privacy.** The server still sees: which user owns a note, counts,
  timestamps (`created_at`/`updated_at`), `is_pinned`, attachment presence/sizes,
  and `feature_events` usage telemetry. Only note *content* is encrypted.
- **AI features.** Organize/Summarize and voice transcription send the relevant
  note's plaintext to OpenAI **for that action only** (decrypted on-device, result
  re-encrypted). These are explicit, user-initiated plaintext egress and are NOT
  covered by the E2EE guarantee. (Product decision: kept for now.)
- **Forward secrecy / post-compromise security.** A single long-lived DEK; no
  ratcheting. Compromise of the DEK exposes all of that user's notes.
- **Protecting against a malicious app build.** E2EE protects against a hostile
  *server*, not a hostile *client*.

## 2. Threat model

| Adversary | Can read notes? | Why |
|---|---|---|
| Network attacker (MITM) | No | TLS + ciphertext payloads |
| Server operator / Railway | No | Only ciphertext + wrapped keys reach the server |
| MongoDB Atlas admin / DB dump / backup | No | Same |
| Lost/stolen unlocked device | Yes | DEK is in the OS keystore for the logged-in user |
| Attacker who knows the password | Yes | Password unwraps the DEK (by design) |
| Attacker with the recovery code | Yes | Recovery code unwraps the DEK (by design) |
| OpenAI (only when user taps AI/voice) | The single note acted on | Explicit egress, see non-goals |

## 3. Primitives

- **Symmetric encryption:** AES-256-GCM (`@noble/ciphers`), 12-byte random nonce
  per encryption, 128-bit auth tag. Authenticated (tamper-evident).
- **KDF:** PBKDF2-HMAC-SHA-512 via **native** `react-native-quick-crypto` (JSI /
  OpenSSL), default `iterations=600_000, dkLen=32`, per-use random 16-byte salt.
  (600k chosen from on-device benchmark: ~350 ms/login on a mid-range Android,
  above the OWASP-2023 210k SHA-512 baseline.)
  Native because pure-JS scrypt/PBKDF2 is unusably slow on Hermes (~69 s/login,
  measured via `/crypto-check`). The portable core (`e2ee.ts`) takes the KDF by
  injection (`configureKdf`); the app wires in quick-crypto, Node tests wire in
  `node:crypto`. Not memory-hard — see §7.
- **CSPRNG:** `@noble/hashes` `randomBytes` → `crypto.getRandomValues`, polyfilled
  on React Native by `react-native-get-random-values` (imported first at app entry).
- **Encoding:** dependency-free base64; ciphertext token format `v1.<b64 nonce>.<b64 ct‖tag>`.

## 4. Key hierarchy

```
password ──pbkdf2(salt_p)──▶ KEK_p ──┐
                                     ├─ wrap(AES-GCM) ─▶ DEK (random 256-bit)
recovery code ─pbkdf2(salt_r)▶ KEK_r ┘
                                     DEK ──AES-256-GCM──▶ note ciphertext
```

- **DEK** — per-user random 256-bit Data Encryption Key. Encrypts all note fields.
  Held on-device in **expo-secure-store** (Android Keystore / iOS Keychain).
- **KEK_p / KEK_r** — derived from password / recovery code via PBKDF2. Never stored.
- **Escrow bundle** (stored server-side, opaque): `wrapped_by_password`,
  `wrapped_by_recovery`, `kdf_salt`, `recovery_salt`, `kdf`, `kdf_params`, `enc_version`.

## 5. Lifecycles

- **Signup:** generate DEK + recovery code; derive KEK_p, KEK_r; wrap DEK under both;
  `PUT /api/crypto/wrapped-key` (escrow). Show recovery code once. Store DEK in SecureStore.
- **Login (new device):** `GET /api/crypto/wrapped-key`; derive KEK_p from password;
  unwrap DEK; store in SecureStore.
- **Password reset:** user supplies recovery code → unwrap DEK via KEK_r → re-wrap
  under KEK_p(new password). **DEK is preserved, so existing notes stay readable.**
- **Lost password AND recovery code:** notes are unrecoverable (by design).

## 6. What the server stores

- `notes`: `title`/`content`/`tags` as `v1.…` ciphertext strings; `enc_version` set.
  (`enc_version=null` ⇒ legacy plaintext pending migration.)
- `user_keys`: the escrow bundle (opaque). Size-capped; never the DEK or plaintext.
- `feature_events`: `{event, user_id, ts, meta}` — metadata only, size-capped.

## 7. Consequences / known limitations

- **Search moves on-device** (server cannot search ciphertext).
- **Migration** of existing plaintext notes is **client-side**, idempotent, gated by
  `enc_version`; must be preceded by an Atlas snapshot.
- **KDF is not memory-hard.** PBKDF2 resists GPU/ASIC cracking less than scrypt/
  Argon2id; we run 600k SHA-512 iterations (above the OWASP-2023 210k baseline).
  Argon2id would be stronger but lacks a maintained native module for this RN 0.83 /
  New-Architecture stack — revisit when one ships. (Pure-JS scrypt was dropped:
  ~69 s/login on Hermes; native PBKDF2 @ 600k is ~350 ms.)
- **No independent audit yet** (see `E2EE-AUDIT-BRIEF.md`).

## 8. Dependencies (audit surface)

- `@noble/ciphers@2.2.0`, `@noble/hashes@2.2.0` (audited, by Paul Miller) — AES-GCM + CSPRNG
- `react-native-quick-crypto@1.1.5` (+ `react-native-nitro-modules`) — native PBKDF2
- `react-native-get-random-values@~1.11.0`, `expo-secure-store`
- Crypto core: `frontend/src/crypto/e2ee.ts` (KDF-injected) + `kdf-native.ts` + tests `e2ee.test.ts`
- Backend escrow: `backend/server.py` (`/api/crypto/wrapped-key`, `enc_version`)
