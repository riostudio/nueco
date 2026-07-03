# MemoPad — End-to-End Encryption Design & Threat Model

_Status: implemented (crypto core, backend escrow, note field encrypt/decrypt,
gated migration). Production rollout gated behind build flags — see §9._
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

Implemented in `frontend/src/crypto/keySession.ts`, run from `AuthContext`. Gated by
the `e2eeKeys` build flag (on for non-production builds; off in prod pending the
rollout in §9).

- **First login / legacy user (no escrow):** signup itself can't escrow (it requires
  email verification, so there's no session yet), so the **escrow is created at first
  login** — which also transparently covers users who predate E2EE. Generate DEK +
  recovery code; derive KEK_p, KEK_r; wrap DEK under both; `PUT /api/crypto/wrapped-key`.
  Show the recovery code once (blocking screen). Store DEK in SecureStore.
- **Login (escrow exists):** `GET /api/crypto/wrapped-key`; derive KEK_p from password;
  unwrap DEK; store in SecureStore.
- **Login after an email-token password reset:** the server can't re-wrap the DEK on a
  reset, so password-unwrap fails → app prompts for the **recovery code**, unwraps via
  KEK_r, re-wraps under KEK_p(new password), and re-PUTs. **DEK preserved.**
- **Authenticated password change:** DEK is already in SecureStore → re-wrap directly
  under the new password (no recovery code needed) and re-PUT.
- **Logout:** DEK cleared from SecureStore.
- **Lost password AND recovery code:** notes are unrecoverable (by design).

## 6. What the server stores

- `notes`: `title`/`content`/`tags` as `v1.…` ciphertext strings; `enc_version` set.
  (`enc_version=null` ⇒ legacy plaintext pending migration.)
- `user_keys`: the escrow bundle (opaque). Size-capped; never the DEK or plaintext.
- `feature_events`: `{event, user_id, ts, meta}` — metadata only, size-capped.

## 7. Consequences / known limitations

- **Search is on-device** (server cannot search ciphertext). The notes list filters
  decrypted local notes client-side; the server `?search=` param was removed.
- **Migration** of existing plaintext notes is **client-side**, idempotent, gated by
  `enc_version`; must be preceded by an Atlas snapshot. See §8/§9.
- **KDF is not memory-hard.** PBKDF2 resists GPU/ASIC cracking less than scrypt/
  Argon2id; we run 600k SHA-512 iterations (above the OWASP-2023 210k baseline).
  Argon2id would be stronger but lacks a maintained native module for this RN 0.83 /
  New-Architecture stack — revisit when one ships. (Pure-JS scrypt was dropped:
  ~69 s/login on Hermes; native PBKDF2 @ 600k is ~350 ms.)
- **No independent audit yet** (see `E2EE-AUDIT-BRIEF.md`).

## 8. Note field encryption (Stage 4)

Where plaintext crosses to/from the server. Local AsyncStorage stays plaintext (the
device is trusted; see threat model) — only the wire/server sees ciphertext.

- **Core:** `frontend/src/crypto/noteCryptoCore.ts` (portable, node-tested) —
  `encryptNoteFields` / `decryptNoteFields`. Encrypts `title`, `content`, and each
  `tag.name`; `tag.color` stays plaintext (not sensitive, needed to render before
  decrypt). Stamps `enc_version = 1`. **`enc_version` is stamped only when an
  encryptable field is present**, so a `linked_event_id`/`is_pinned`-only partial
  update can't mislabel a note (the backend uses `exclude_unset`, preserving the
  stored value). Idempotent (won't double-encrypt); an undecryptable field yields a
  placeholder rather than throwing.
- **Device wiring:** `noteCrypto.ts` loads the DEK from the keystore and honours the
  flag (no-op passthrough when off / on web / no DEK).
- **Boundaries wired:** `offlineSync.ts` (encrypt on `create`/`update` push; decrypt
  on `getAll`/`get` pull) **and** `editor.tsx` (which calls `notesApi` directly:
  encrypts all save payloads, decrypts on load). These are the only note↔server
  crossings.
- **Size caps:** note fields arrive as base64 AES-GCM ciphertext, which inflates a
  plaintext field to just over 4× its char count in the worst case (all 3-byte UTF-8
  / CJK; measured 1000-char title → 4044 chars). Backend caps carry 5× headroom
  (`_CIPHERTEXT_HEADROOM`): title ~5 KB, content ~1.25 MB — still far under Mongo's
  16 MB doc limit.
- **Migration:** `noteMigration.ts` `migrateNotesToEncrypted` runs once at login (when
  the DEK is present), re-PUTting each `enc_version==null` note as ciphertext.
  Idempotent, best-effort (per-note failures retried next login), per-user run-once
  marker. Gated OFF by `E2EE_MIGRATION_ENABLED` (§9).
- **Verification:** unit tests (`noteCryptoCore.test.ts`, `yarn test:crypto`) + a
  device-free backend integration check (`scripts/e2ee-backend-check.ts`,
  `yarn check:e2ee-backend`) that exercises the real crypto against a deployed API.

## 9. Rollout (production enablement)

Two independent build flags (`app.config.js` → `extra`, read via `expo-constants`),
both OFF in production by default. Ordered rollout, with two irreversible gates:

1. **Deploy backend** (raised caps + on-device search) from source, root dir
   `backend` — never `railway up` from the repo root.
2. **Verify** on the deployed backend: `yarn check:e2ee-backend` (or a preview build).
3. **Atlas snapshot** — mandatory before any migration; the migration rewrites every
   plaintext note and there is no rollback without it.
4. **Run migration:** build with `E2EE_MIGRATION=1` (→ `extra.e2eeMigration`); notes
   migrate at each user's next login. Idempotent, so safe to leave on.
5. **Enable E2EE in prod (irreversible):** set `e2eeKeys` on for production builds.
   Any note saved after this is unreadable server-side. Lost password **and** recovery
   code ⇒ unrecoverable notes (§5).

## 10. Dependencies (audit surface)

- `@noble/ciphers@2.2.0`, `@noble/hashes@2.2.0` (audited, by Paul Miller) — AES-GCM + CSPRNG
- `react-native-quick-crypto@1.1.5` (+ `react-native-nitro-modules`) — native PBKDF2
- `react-native-get-random-values@~1.11.0`, `expo-secure-store`
- Crypto core: `frontend/src/crypto/e2ee.ts` (KDF-injected) + `kdf-native.ts` + tests `e2ee.test.ts`
- Backend escrow: `backend/server.py` (`/api/crypto/wrapped-key`, `enc_version`)
