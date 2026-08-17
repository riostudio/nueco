/**
 * Trip field encryption - the single boundary where trip data crosses to/from the
 * server. Called from `offlineSync.ts`: encrypt on push (`tripsApi.create`/`update`),
 * decrypt on pull (`tripsApi.getAll`/`get`). Local storage keeps plaintext - the device
 * is trusted; only the wire/server is not.
 *
 * This module wires the portable core (`tripCryptoCore.ts`) to the device keystore and
 * the E2EE flag. The pure crypto (and its unit tests) live in the core.
 */
import {
  encryptTripFields,
  decryptTripFields,
  hasEncryptableFields,
  type EncryptableTrip,
} from './tripCryptoCore';
import { loadDek } from './keystore';
import { E2EE_KEYS_ENABLED } from './flags';
import { yieldToJS } from './yieldToJS';
import { Platform } from 'react-native';

// See eventCrypto.ts's DECRYPT_YIELD_EVERY - same reasoning, applied to trips.
const DECRYPT_YIELD_EVERY = 25;

export {
  encryptTripFields,
  decryptTripFields,
  UNDECRYPTABLE_PLACEHOLDER,
  type EncryptableTrip,
} from './tripCryptoCore';

/**
 * Encrypt a create/update payload before it leaves the device. No-op (returns the
 * payload unchanged) when E2EE is disabled by flag, or on web / when no DEK is
 * loaded - the trip is then stored server-side as legacy plaintext.
 */
export async function encryptTripForServer<T extends EncryptableTrip>(payload: T): Promise<T> {
  if (!E2EE_KEYS_ENABLED) return payload;
  const dek = await loadDek();
  if (!dek) {
    // See noteCrypto.ts: pushing plaintext while the server copy keeps enc_version=1
    // corrupts the next decrypt - refuse on native and let the sync queue retry.
    if (Platform.OS !== 'web' && hasEncryptableFields(payload)) {
      throw new Error('E2EE key not loaded - refusing to push plaintext');
    }
    return payload;
  }
  return encryptTripFields(payload, dek);
}

/**
 * Decrypt a trip fetched from the server. Plaintext trips pass through. When no DEK is
 * available we return the trip untouched - a still-ciphertext field renders as-is,
 * which is preferable to crashing; this only happens if the flag is on but the keystore
 * is empty (an unexpected, transient state).
 */
export async function decryptTripFromServer<T extends EncryptableTrip>(trip: T): Promise<T> {
  const dek = await loadDek();
  if (!dek) return trip;
  return decryptTripFields(trip, dek);
}

export async function decryptTripsFromServer<T extends EncryptableTrip>(trips: T[]): Promise<T[]> {
  const dek = await loadDek();
  if (!dek) return trips;
  const out: T[] = [];
  for (let i = 0; i < trips.length; i++) {
    out.push(decryptTripFields(trips[i], dek));
    if ((i + 1) % DECRYPT_YIELD_EVERY === 0) await yieldToJS();
  }
  return out;
}
