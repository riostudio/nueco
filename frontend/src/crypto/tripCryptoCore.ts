/**
 * Portable core for trip field encryption. Depends only on the E2EE primitives - no
 * keystore, no Expo, no React Native - so it runs under plain Node for unit tests,
 * exactly like `eventCryptoCore.ts`. The device/flag wiring lives in `tripCrypto.ts`,
 * which imports these.
 *
 * What gets encrypted: `name`, `description`. Encrypted trips carry `enc_version = 1`;
 * plaintext (legacy / pre-migration) trips have `enc_version == null` and pass through
 * untouched, so a mixed server state during migration always renders correctly.
 */
import { encryptString, decryptString, ENC_VERSION } from './e2ee';

/** Shown in place of a field we hold ciphertext for but cannot decrypt (wrong key /
 * tamper / corruption). Never crash the list over one bad trip. */
export const UNDECRYPTABLE_PLACEHOLDER = '⚠️ Unable to decrypt';

/** The encryptable subset of a trip. Extra fields are preserved untouched (deliberately
 * no index signature here - it would force every caller's concrete trip type to also
 * declare one just to satisfy this generic constraint). */
export interface EncryptableTrip {
  name?: string;
  description?: string;
  enc_version?: number | null;
}

/**
 * Encrypt a trip's plaintext fields under `dek` and stamp `enc_version`. Only the
 * fields actually present are encrypted (so a description-only update payload stays
 * partial). Idempotent guard: an already-encrypted payload (enc_version === ENC_VERSION)
 * is returned unchanged, so this can never double-encrypt.
 */
export function encryptTripFields<T extends EncryptableTrip>(
  trip: T,
  dek: Uint8Array,
): T & { enc_version?: number } {
  if (trip.enc_version === ENC_VERSION) return trip as T & { enc_version?: number }; // already encrypted - never re-wrap

  const hasName = typeof trip.name === 'string';
  const hasDescription = typeof trip.description === 'string';
  if (!hasName && !hasDescription) return trip as T & { enc_version?: number };

  const out: EncryptableTrip = { ...trip, enc_version: ENC_VERSION };
  if (hasName) out.name = encryptString(trip.name as string, dek);
  if (hasDescription) out.description = encryptString(trip.description as string, dek);
  return out as T & { enc_version: number };
}

/**
 * Decrypt a trip that came from the server. Plaintext trips (enc_version != ENC_VERSION)
 * pass straight through. A field that fails to decrypt is replaced with a placeholder
 * rather than throwing, so one corrupt trip can't blank the list. The returned trip has
 * `enc_version` cleared, marking it as decrypted plaintext for in-app use.
 */
export function decryptTripFields<T extends EncryptableTrip>(
  trip: T,
  dek: Uint8Array,
): T & { enc_version?: number | null } {
  if (trip.enc_version !== ENC_VERSION) return trip as T & { enc_version?: number | null }; // legacy plaintext - nothing to do

  const safe = (token: unknown): string =>
    typeof token === 'string' ? tryDecrypt(token, dek) : (token as string);

  const out: EncryptableTrip = { ...trip, enc_version: null };
  if (typeof trip.name === 'string') out.name = safe(trip.name);
  if (typeof trip.description === 'string') out.description = safe(trip.description);
  return out as T & { enc_version: number | null };
}

/**
 * True when a payload carries at least one encryptable field. `encryptTripFields` itself
 * already handles field-less payloads; exposed for callers that want to know whether
 * encryption applies before doing other work.
 */
export function hasEncryptableFields(trip: EncryptableTrip): boolean {
  return typeof trip.name === 'string' || typeof trip.description === 'string';
}

/**
 * Select the trips that still need migrating to ciphertext - i.e. legacy plaintext
 * (`enc_version == null`). Already-encrypted trips are skipped, which makes the
 * migration idempotent and safe to re-run.
 */
export function tripsNeedingMigration<T extends EncryptableTrip>(trips: T[]): T[] {
  return trips.filter((t) => t.enc_version == null);
}

function tryDecrypt(token: string, dek: Uint8Array): string {
  // Mislabeled plaintext (a no-DEK push racing a key clear) is not a decrypt failure -
  // pass it through so the trip heals instead of showing the placeholder.
  if (!(token.startsWith(`v${ENC_VERSION}.`) && token.split('.').length === 3)) return token;
  try {
    return decryptString(token, dek);
  } catch {
    return UNDECRYPTABLE_PLACEHOLDER;
  }
}
