/**
 * One-time eager migration of legacy plaintext notes to E2EE ciphertext (Stage 4).
 *
 * DANGER / IRREVERSIBLE: this rewrites every plaintext note document server-side.
 * It is gated by `E2EE_MIGRATION_ENABLED` (default OFF) and MUST be preceded by an
 * Atlas snapshot — see E2EE-DESIGN.md §7. Nothing here runs until that flag is
 * flipped and the app rebuilt.
 *
 * Properties:
 *  - Idempotent: only touches notes with `enc_version == null`; re-running is a
 *    cheap no-op once everything is encrypted.
 *  - Non-blocking / best-effort: any failure is swallowed and retried on the next
 *    login (the per-user "done" marker is only set when nothing failed).
 *  - Minimal payload: re-PUTs only title/content/tags (+enc_version). The backend
 *    uses exclude_unset, so untouched fields (images, pin, links) are preserved.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { notesApi } from '../api';
import { encryptNoteFields, notesNeedingMigration, type EncryptableNote } from './noteCryptoCore';
import { loadDek } from './keystore';
import { E2EE_MIGRATION_ENABLED } from './flags';

export type MigrationResult =
  | { status: 'skipped'; reason: 'disabled' | 'no-key' | 'already-done' }
  | { status: 'done'; total: number; migrated: number; failed: number };

const DONE_KEY_PREFIX = 'e2ee:migration:v1:done:';
const doneKey = (userId: string) => `${DONE_KEY_PREFIX}${userId}`;

async function isMigrationDone(userId: string): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(doneKey(userId))) === '1';
  } catch {
    return false;
  }
}

async function markMigrationDone(userId: string): Promise<void> {
  try {
    await AsyncStorage.setItem(doneKey(userId), '1');
  } catch {
    // A missing marker only costs one extra getAll next login — safe to ignore.
  }
}

interface ServerNote extends EncryptableNote {
  id: string;
}

/**
 * Encrypt every legacy plaintext note for `userId` and re-PUT it. Returns a summary;
 * see module doc for the safety properties. `userId` scopes the run-once marker so a
 * second account on the same device migrates independently.
 */
export async function migrateNotesToEncrypted(userId: string | undefined): Promise<MigrationResult> {
  if (!E2EE_MIGRATION_ENABLED) return { status: 'skipped', reason: 'disabled' };
  if (!userId) return { status: 'skipped', reason: 'no-key' };

  const dek = await loadDek();
  if (!dek) return { status: 'skipped', reason: 'no-key' };
  if (await isMigrationDone(userId)) return { status: 'skipped', reason: 'already-done' };

  const all: ServerNote[] = await notesApi.getAll();
  const pending = notesNeedingMigration(all);

  let migrated = 0;
  let failed = 0;
  for (const note of pending) {
    try {
      const payload = encryptNoteFields(
        { title: note.title ?? '', content: note.content ?? '', tags: note.tags ?? [] },
        dek,
      );
      await notesApi.update(note.id, payload);
      migrated += 1;
    } catch (e) {
      failed += 1;
      console.warn('E2EE migration: failed to encrypt note', note.id, e);
    }
  }

  // Only mark done when the whole pass succeeded — otherwise retry next login.
  if (failed === 0) await markMigrationDone(userId);

  return { status: 'done', total: pending.length, migrated, failed };
}
