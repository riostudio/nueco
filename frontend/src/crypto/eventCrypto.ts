/**
 * Calendar event field encryption - the single boundary where event data crosses
 * to/from the server (Stage 5). Called from `offlineSync.ts` and `calendarSync.ts`:
 * encrypt on push (`eventsApi.create`/`update`), decrypt on pull
 * (`eventsApi.getAll`/`get`). Local AsyncStorage keeps plaintext - the device is
 * trusted; only the wire/server is not.
 *
 * This module wires the portable core (`eventCryptoCore.ts`) to the device keystore
 * and the E2EE flag. The pure crypto (and its unit tests) live in the core.
 */
import {
  encryptEventFields,
  decryptEventFields,
  type EncryptableEvent,
} from './eventCryptoCore';
import { loadDek } from './keystore';
import { E2EE_KEYS_ENABLED } from './flags';
import { yieldToJS } from './yieldToJS';

// See noteCrypto.ts's DECRYPT_YIELD_EVERY - same reasoning, applied to events.
const DECRYPT_YIELD_EVERY = 25;

export {
  encryptEventFields,
  decryptEventFields,
  UNDECRYPTABLE_PLACEHOLDER,
  type EncryptableEvent,
} from './eventCryptoCore';

/**
 * Encrypt a create/update payload before it leaves the device. No-op (returns the
 * payload unchanged) when E2EE is disabled by flag, or on web / when no DEK is
 * loaded - the event is then stored server-side as legacy plaintext.
 */
export async function encryptEventForServer<T extends EncryptableEvent>(payload: T): Promise<T> {
  if (!E2EE_KEYS_ENABLED) return payload;
  const dek = await loadDek();
  if (!dek) return payload;
  return encryptEventFields(payload, dek);
}

/**
 * Decrypt an event fetched from the server. Plaintext events pass through. When no
 * DEK is available we return the event untouched - a still-ciphertext field renders
 * as-is, which is preferable to crashing; this only happens if the flag is on but the
 * keystore is empty (an unexpected, transient state).
 */
export async function decryptEventFromServer<T extends EncryptableEvent>(event: T): Promise<T> {
  const dek = await loadDek();
  if (!dek) return event;
  return decryptEventFields(event, dek);
}

export async function decryptEventsFromServer<T extends EncryptableEvent>(events: T[]): Promise<T[]> {
  const dek = await loadDek();
  if (!dek) return events;
  const out: T[] = [];
  for (let i = 0; i < events.length; i++) {
    out.push(decryptEventFields(events[i], dek));
    if ((i + 1) % DECRYPT_YIELD_EVERY === 0) await yieldToJS();
  }
  return out;
}
