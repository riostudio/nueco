/**
 * End-to-end encryption core for MemoPad notes.
 *
 * Threat model: the server only ever stores ciphertext + opaque wrapped keys.
 * Note content is encrypted on-device with AES-256-GCM under a per-user random
 * Data Encryption Key (DEK). The DEK is wrapped by two Key Encryption Keys
 * (KEKs) derived via scrypt — one from the user's password, one from a recovery
 * code — so a forgotten password can be recovered without the server ever seeing
 * the DEK or plaintext.
 *
 * Pure/portable: depends only on @noble (audited) + TextEncoder/Decoder. Works in
 * React Native (Hermes) and Node. RN MUST install a CSPRNG polyfill at app entry
 * (`import 'react-native-get-random-values'`) so @noble's randomBytes is secure.
 */
import { gcm } from '@noble/ciphers/aes.js';
import { scrypt } from '@noble/hashes/scrypt.js';
import { randomBytes } from '@noble/hashes/utils.js';

export const ENC_VERSION = 1;
const NONCE_BYTES = 12; // AES-GCM standard nonce
const KEY_BYTES = 32; // AES-256
const SALT_BYTES = 16;

/** scrypt cost params. N=2^15 is a mobile-reasonable login cost (~hundreds of ms). */
export interface KdfParams {
  N: number;
  r: number;
  p: number;
  dkLen: number;
}
export const DEFAULT_KDF: KdfParams = { N: 1 << 15, r: 8, p: 1, dkLen: KEY_BYTES };

export interface EscrowBundle {
  wrapped_by_password: string; // DEK wrapped by password KEK
  wrapped_by_recovery: string; // DEK wrapped by recovery-code KEK
  kdf_salt: string; // base64 salt for the password KEK
  recovery_salt: string; // base64 salt for the recovery KEK
  kdf: 'scrypt';
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

export function deriveKek(secret: string, salt: Uint8Array, params: KdfParams = DEFAULT_KDF): Uint8Array {
  return scrypt(utf8(secret), salt, params);
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
      kdf: 'scrypt',
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

/** Password reset: recover the DEK via the recovery code, re-wrap under a new
 * password. The DEK is preserved, so existing encrypted notes stay readable. */
export function rewrapForNewPassword(bundle: EscrowBundle, recoveryCode: string, newPassword: string): EscrowBundle {
  const dek = unlockWithRecovery(bundle, recoveryCode);
  const pSalt = randomBytes(SALT_BYTES);
  const pKek = deriveKek(newPassword, pSalt);
  return { ...bundle, wrapped_by_password: wrapKey(dek, pKek), kdf_salt: toB64(pSalt) };
}
