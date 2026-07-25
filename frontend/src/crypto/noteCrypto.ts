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
  type EncryptableNote,
} from './noteCryptoCore';
import { loadDek } from './keystore';
import { E2EE_KEYS_ENABLED } from './flags';
import { yieldToJS } from './yieldToJS';

// Every this-many notes, yield to the event loop so decrypting a large collection
// in one fullSync pass doesn't freeze touch handling / animations app-wide for the
// whole loop - see the (tabs)/index.tsx and (tabs)/events.tsx focus-triggered sync.
const DECRYPT_YIELD_EVERY = 25;

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
  if (!dek) return payload;
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
  for (let i = 0; i < notes.length; i++) {
    out.push(decryptNoteFields(notes[i], dek));
    if ((i + 1) % DECRYPT_YIELD_EVERY === 0) await yieldToJS();
  }
  return out;
}
