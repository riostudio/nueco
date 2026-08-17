/**
 * Note field encryption - the single boundary where note data crosses to/from the
 * server (Stage 4). Called from `offlineSync.ts`: encrypt on push
 * (`notesApi.create`/`update`), decrypt on pull (`notesApi.getAll`/`get`). Local
 * AsyncStorage keeps plaintext - the device is trusted; only the wire/server is not.
 *
 * This module wires the portable core (`noteCryptoCore.ts`) to the device keystore
 * and the E2EE flag. The pure crypto (and its unit tests) live in the core.
 */
import {
  encryptNoteFields,
  decryptNoteFields,
  hasEncryptableFields,
  type EncryptableNote,
} from './noteCryptoCore';
import { loadDek } from './keystore';
import { E2EE_KEYS_ENABLED } from './flags';
import { yieldToJS } from './yieldToJS';
import { Platform } from 'react-native';

// Yield to the event loop periodically so decrypting a large collection in one fullSync pass
// doesn't freeze touch handling / animations app-wide for the whole loop - see the
// (tabs)/index.tsx and (tabs)/events.tsx focus-triggered sync.
//
// Counting notes alone is the wrong budget: cost is driven by ciphertext SIZE, and a note with
// inline base64 images is orders of magnitude bigger than a text one. 25 image-bearing notes
// between yields is a multi-hundred-millisecond stall - exactly the "the app hitches right after
// I saved something" symptom - while 25 short notes is nothing. Yield on whichever limit is hit
// first, so the gap between yields is bounded by work done rather than by item count.
const DECRYPT_YIELD_EVERY = 25;
const DECRYPT_YIELD_BYTES = 128 * 1024;

export {
  encryptNoteFields,
  decryptNoteFields,
  UNDECRYPTABLE_PLACEHOLDER,
  type EncryptableNote,
  type TagLike,
} from './noteCryptoCore';

/**
 * Encrypt a create/update payload before it leaves the device. No-op (returns the
 * payload unchanged) when E2EE is disabled by flag, or on web / when no DEK is
 * loaded - the note is then stored server-side as legacy plaintext.
 */
export async function encryptNoteForServer<T extends EncryptableNote>(payload: T): Promise<T> {
  if (!E2EE_KEYS_ENABLED) return payload;
  const dek = await loadDek();
  if (!dek) {
    // Web has no SecureStore, so E2EE is native-only and the no-op stands there. On native,
    // pushing plaintext while the server copy keeps enc_version=1 turns the next decrypt into
    // a placeholder (a logout racing an unawaited sync did exactly this) - refuse instead; the
    // sync queue retains the item and retries once the key is back.
    if (Platform.OS !== 'web' && hasEncryptableFields(payload)) {
      throw new Error('E2EE key not loaded - refusing to push plaintext');
    }
    return payload;
  }
  return encryptNoteFields(payload, dek);
}

/**
 * Decrypt a note fetched from the server. Plaintext notes pass through. When no DEK
 * is available we return the note untouched - a still-ciphertext field renders as-is,
 * which is preferable to crashing; this only happens if the flag is on but the
 * keystore is empty (an unexpected, transient state).
 */
export async function decryptNoteFromServer<T extends EncryptableNote>(note: T): Promise<T> {
  const dek = await loadDek();
  if (!dek) return note;
  return decryptNoteFields(note, dek);
}

export async function decryptNotesFromServer<T extends EncryptableNote>(notes: T[]): Promise<T[]> {
  const dek = await loadDek();
  if (!dek) return notes;
  const out: T[] = [];
  let sinceYield = 0;
  let bytesSinceYield = 0;
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    bytesSinceYield += typeof note.content === 'string' ? note.content.length : 0;
    out.push(decryptNoteFields(note, dek));
    sinceYield++;
    if (sinceYield >= DECRYPT_YIELD_EVERY || bytesSinceYield >= DECRYPT_YIELD_BYTES) {
      sinceYield = 0;
      bytesSinceYield = 0;
      await yieldToJS();
    }
  }
  return out;
}
