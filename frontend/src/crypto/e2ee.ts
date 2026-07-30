/**
 * End-to-end encryption core for Nueco notes.
 *
 * Threat model: the server only ever stores ciphertext + opaque wrapped keys.
 * Note content is encrypted on-device with AES-256-GCM under a per-user random
 * Data Encryption Key (DEK). The DEK is wrapped by two Key Encryption Keys
 * (KEKs) derived via scrypt - one from the user's password, one from a recovery
 * code - so a forgotten password can be recovered without the server ever seeing
 * the DEK or plaintext.
 *
 * Pure/portable: depends only on @noble (audited) + TextEncoder/Decoder for the
 * AES/CSPRNG core. Works in React Native (Hermes) and Node. RN MUST install a
 * CSPRNG polyfill at app entry (`import 'react-native-get-random-values'`) so
 * @noble's randomBytes is secure.
 *
 * The KDF (PBKDF2) is *injected* via `configureKdf()` rather than imported here,
 * because pure-JS scrypt/PBKDF2 is far too slow under Hermes (measured ~69 s/login
 * on a mid-range Android). The app wires in a native PBKDF2 (react-native-quick-
 * crypto) at entry; Node tests wire in node:crypto. See `kdf-native.ts`.
 */
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/hashes/utils.js';

export const ENC_VERSION = 1;
const NONCE_BYTES = 12; // AES-GCM standard nonce
const KEY_BYTES = 32; // AES-256
const SALT_BYTES = 16;

/**
 * PBKDF2 cost params. PBKDF2-HMAC-SHA-512 @ 600k iterations - above the OWASP-2023
 * baseline (210k for SHA-512), chosen from an on-device benchmark: ~350 ms/login on
 * a mid-range Android (moto g56), ~1 s on a phone 3× slower. At native speed
 * (quick-crypto) this is comfortably within the 250–500 ms login budget.
 * (Not memory-hard like scrypt/Argon2 - see E2EE-DESIGN.md for the tradeoff.)
 */
export interface KdfParams {
  iterations: number;
  hash: 'sha512' | 'sha256';
  dkLen: number;
}
export const DEFAULT_KDF: KdfParams = { iterations: 600_000, hash: 'sha512', dkLen: KEY_BYTES };

export interface EscrowBundle {
  wrapped_by_password: string; // DEK wrapped by password KEK
  wrapped_by_recovery: string; // DEK wrapped by recovery-code KEK
  kdf_salt: string; // base64 salt for the password KEK
  recovery_salt: string; // base64 salt for the recovery KEK
  kdf: 'pbkdf2';
  kdf_params: KdfParams;
  enc_version: number;
}

// ---- base64 (dependency-free, portable) ------------------------------------
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < B64.length; i++) m[B64[i]] = i;
  return m;
})();

export function toB64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    out += b1 === undefined ? '=' : B64[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    out += b2 === undefined ? '=' : B64[b2 & 63];
  }
  return out;
}

export function fromB64(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let bits = 0;
  let value = 0;
  let p = 0;
  for (const ch of clean) {
    const v = B64_LOOKUP[ch];
    if (v === undefined) throw new Error('invalid base64');
    value = (value << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[p++] = (value >> bits) & 0xff;
    }
  }
  return out;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const utf8 = (s: string) => enc.encode(s);
const fromUtf8 = (b: Uint8Array) => dec.decode(b);

// ---- low-level authenticated encryption ------------------------------------
function encryptBytes(plain: Uint8Array, key: Uint8Array): string {
  const nonce = randomBytes(NONCE_BYTES);
  const ct = gcm(key, nonce).encrypt(plain);
  return `v${ENC_VERSION}.${toB64(nonce)}.${toB64(ct)}`;
}

function decryptBytes(token: string, key: Uint8Array): Uint8Array {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== `v${ENC_VERSION}`) {
    throw new Error('unsupported or malformed ciphertext');
  }
  const nonce = fromB64(parts[1]);
  const ct = fromB64(parts[2]);
  return gcm(key, nonce).decrypt(ct); // throws on auth-tag mismatch (tamper/wrong key)
}

/** Encrypt a UTF-8 string with a 32-byte key → `v1.<nonce>.<ciphertext>`. */
export function encryptString(plaintext: string, key: Uint8Array): string {
  return encryptBytes(utf8(plaintext), key);
}

/** Decrypt a token produced by encryptString. Throws if tampered or wrong key. */
export function decryptString(token: string, key: Uint8Array): string {
  return fromUtf8(decryptBytes(token, key));
}

// ---- keys ------------------------------------------------------------------
export function generateDek(): Uint8Array {
  return randomBytes(KEY_BYTES);
}

/**
 * Pluggable KDF. The implementation is injected so the portable core never
 * imports a platform-specific (native) crypto module. Must take raw bytes and
 * return `params.dkLen` derived bytes. Call `configureKdf()` once at startup.
 */
export type KdfImpl = (secret: Uint8Array, salt: Uint8Array, params: KdfParams) => Uint8Array;

let kdfImpl: KdfImpl | null = null;

/** Wire in the platform PBKDF2 (native on RN, node:crypto in tests). Idempotent. */
export function configureKdf(fn: KdfImpl): void {
  kdfImpl = fn;
}

export function deriveKek(secret: string, salt: Uint8Array, params: KdfParams = DEFAULT_KDF): Uint8Array {
  if (!kdfImpl) {
    throw new Error('E2EE KDF not configured - import the kdf-native wiring at app entry (see kdf-native.ts)');
  }
  return kdfImpl(utf8(secret), salt, params);
}

export function wrapKey(rawKey: Uint8Array, kek: Uint8Array): string {
  return encryptBytes(rawKey, kek);
}

export function unwrapKey(token: string, kek: Uint8Array): Uint8Array {
  return decryptBytes(token, kek);
}

// ---- recovery code ---------------------------------------------------------
// 32-symbol alphabet, no ambiguous chars (no 0/O/1/I). 256 % 32 === 0 ⇒ no modulo bias.
const RC_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RC_BYTES = 24; // 24 symbols × 5 bits = 120 bits of entropy

export function generateRecoveryCode(): string {
  const bytes = randomBytes(RC_BYTES);
  let raw = '';
  for (const b of bytes) raw += RC_ALPHABET[b % 32];
  return raw.match(/.{1,4}/g)!.join('-'); // e.g. ABCD-EFGH-…
}

/** Strip formatting so "abcd-efgh" and "ABCD EFGH" derive the same key. */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// ---- escrow (signup / login / recovery / reset) ----------------------------
/** Create a fresh DEK + recovery code and wrap the DEK under both KEKs. */
export function createEscrow(
  password: string,
  recoveryCode?: string,
): { dek: Uint8Array; recoveryCode: string; bundle: EscrowBundle } {
  const dek = generateDek();
  const rc = recoveryCode ?? generateRecoveryCode();
  const pSalt = randomBytes(SALT_BYTES);
  const rSalt = randomBytes(SALT_BYTES);
  const pKek = deriveKek(password, pSalt);
  const rKek = deriveKek(normalizeRecoveryCode(rc), rSalt);
  return {
    dek,
    recoveryCode: rc,
    bundle: {
      wrapped_by_password: wrapKey(dek, pKek),
      wrapped_by_recovery: wrapKey(dek, rKek),
      kdf_salt: toB64(pSalt),
      recovery_salt: toB64(rSalt),
      kdf: 'pbkdf2',
      kdf_params: DEFAULT_KDF,
      enc_version: ENC_VERSION,
    },
  };
}

export function unlockWithPassword(bundle: EscrowBundle, password: string): Uint8Array {
  const kek = deriveKek(password, fromB64(bundle.kdf_salt), bundle.kdf_params);
  return unwrapKey(bundle.wrapped_by_password, kek); // throws on wrong password
}

export function unlockWithRecovery(bundle: EscrowBundle, recoveryCode: string): Uint8Array {
  const kek = deriveKek(normalizeRecoveryCode(recoveryCode), fromB64(bundle.recovery_salt), bundle.kdf_params);
  return unwrapKey(bundle.wrapped_by_recovery, kek); // throws on wrong code
}

/** Re-wrap a known DEK under a new password (fresh salt). Used when the DEK is
 * already in hand - e.g. an authenticated password change. Preserves the DEK. */
export function rewrapWithDek(bundle: EscrowBundle, dek: Uint8Array, newPassword: string): EscrowBundle {
  const pSalt = randomBytes(SALT_BYTES);
  const pKek = deriveKek(newPassword, pSalt, bundle.kdf_params);
  return { ...bundle, wrapped_by_password: wrapKey(dek, pKek), kdf_salt: toB64(pSalt) };
}

/** Password reset: recover the DEK via the recovery code, re-wrap under a new
 * password. The DEK is preserved, so existing encrypted notes stay readable. */
export function rewrapForNewPassword(bundle: EscrowBundle, recoveryCode: string, newPassword: string): EscrowBundle {
  const dek = unlockWithRecovery(bundle, recoveryCode);
  return rewrapWithDek(bundle, dek, newPassword);
}
