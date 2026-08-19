/**
 * Portable core for note field encryption (Stage 4). Depends only on the E2EE
 * primitives - no keystore, no Expo, no React Native - so it runs under plain Node
 * for unit tests, exactly like `e2ee.ts`. The device/flag wiring lives in
 * `noteCrypto.ts`, which imports these.
 *
 * What gets encrypted: `title`, `content`, each `tag.name`, and each `attachment.filename`.
 * `tag.color` stays plaintext (not sensitive, and the UI needs it to render before decrypt), as
 * does the rest of an attachment's metadata (its S3 key/size/mime type must stay readable for
 * storage to function). Attachment FILE BYTES are encrypted separately and never pass through
 * here - see attachmentCrypto.ts, which streams them chunk-by-chunk. Encrypted
 * notes carry `enc_version = 1`; plaintext (legacy / pre-migration) notes have
 * `enc_version == null` and pass through untouched, so a mixed server state during
 * migration always renders correctly.
 */
import { encryptString, decryptString, ENC_VERSION } from './e2ee';

/** Shown in place of a field we hold ciphertext for but cannot decrypt (wrong key /
 * tamper / corruption). Never crash the list over one bad note. */
export const UNDECRYPTABLE_PLACEHOLDER = '⚠️ Unable to decrypt';

export interface TagLike {
  name: string;
  color: string;
}

/** The encryptable subset of a note. Extra fields are preserved untouched. */
export interface EncryptableNote {
  title?: string;
  content?: string;
  tags?: TagLike[] | null;
  // Only `filename` is encrypted on an attachment. The rest of the metadata (id, S3 key, size,
  // mime type) has to stay readable for the storage layer to work at all, but the filename is the
  // part that actually leaks - "MRI results.pdf" tells you plenty without opening it.
  attachments?: AttachmentLike[] | null;
  enc_version?: number | null;
  [k: string]: unknown;
}

export interface AttachmentLike {
  filename?: string;
  [k: string]: unknown;
}

/**
 * True if a value looks like one of our ciphertext tokens (`v1.<nonce>.<ct>`).
 *
 * Needed for attachment filenames specifically: filename encryption shipped after note
 * encryption, so an already-encrypted note (enc_version === 1) can legitimately carry attachments
 * whose filenames were written as plaintext. Those must pass through untouched rather than being
 * run through tryDecrypt, which would fail and replace a perfectly good filename with the
 * "undecryptable" placeholder. Title/content/tags don't need this - they've been encrypted for as
 * long as enc_version has been set, so anything under that flag is genuinely ciphertext.
 */
function looksLikeCiphertext(value: string): boolean {
  return value.startsWith(`v${ENC_VERSION}.`) && value.split('.').length === 3;
}

/**
 * Encrypt a note's plaintext fields under `dek` and stamp `enc_version`. Only the
 * fields actually present are encrypted (so a partial update payload stays partial).
 * Idempotent guard: an already-encrypted payload (enc_version === ENC_VERSION) is
 * returned unchanged, so this can never double-encrypt.
 */
export function encryptNoteFields<T extends EncryptableNote>(
  note: T,
  dek: Uint8Array,
): T & { enc_version?: number } {
  if (note.enc_version === ENC_VERSION) return note as T & { enc_version?: number }; // already encrypted - never re-wrap

  const hasTitle = typeof note.title === 'string';
  const hasContent = typeof note.content === 'string';
  const hasTags = Array.isArray(note.tags);
  const hasAttachments = Array.isArray(note.attachments);
  // A payload carrying none of the encryptable fields (e.g. a linked_event_id- or
  // is_pinned-only update) must NOT claim the note is encrypted - leaving enc_version
  // unset means the backend (which uses exclude_unset) preserves the stored value.
  // Callers always send title+content together, so we never half-encrypt a note.
  if (!hasTitle && !hasContent && !hasTags && !hasAttachments) return note as T & { enc_version?: number };

  const out: EncryptableNote = { ...note, enc_version: ENC_VERSION };
  if (hasTitle) out.title = encryptString(note.title as string, dek);
  if (hasContent) out.content = encryptString(note.content as string, dek);
  if (hasTags) {
    out.tags = note.tags!.map((t) => ({ ...t, name: encryptString(t.name, dek) }));
  }
  if (hasAttachments) {
    out.attachments = note.attachments!.map((a) =>
      typeof a.filename === 'string' && !looksLikeCiphertext(a.filename)
        ? { ...a, filename: encryptString(a.filename, dek) }
        : a,
    );
  }
  return out as T & { enc_version: number };
}

/**
 * Decrypt a note that came from the server. Plaintext notes (enc_version !=
 * ENC_VERSION) pass straight through. A field that fails to decrypt is replaced
 * with a placeholder rather than throwing, so one corrupt note can't blank the list.
 * The returned note has `enc_version` cleared, marking it as decrypted plaintext
 * for in-app use.
 */
export function decryptNoteFields<T extends EncryptableNote>(
  note: T,
  dek: Uint8Array,
): T & { enc_version?: number | null } {
  if (note.enc_version !== ENC_VERSION) return note as T & { enc_version?: number | null }; // legacy plaintext - nothing to do

  const safe = (token: unknown): string =>
    typeof token === 'string' ? tryDecrypt(token, dek) : (token as string);

  const out: EncryptableNote = { ...note, enc_version: null };
  if (typeof note.title === 'string') out.title = safe(note.title);
  if (typeof note.content === 'string') out.content = safe(note.content);
  if (Array.isArray(note.tags)) {
    out.tags = note.tags.map((t) => ({ ...t, name: safe(t.name) }));
  }
  if (Array.isArray(note.attachments)) {
    out.attachments = note.attachments.map((a) =>
      typeof a.filename === 'string' && looksLikeCiphertext(a.filename)
        ? { ...a, filename: safe(a.filename) }
        : a,
    );
  }
  return out as T & { enc_version: number | null };
}

/**
 * True when a payload carries at least one encryptable field. Used by callers that
 * want to know whether encryption applies (e.g. skip a no-op for linked_event_id-only
 * updates); `encryptNoteFields` itself already handles field-less payloads.
 */
export function hasEncryptableFields(note: EncryptableNote): boolean {
  return typeof note.title === 'string' || typeof note.content === 'string' || Array.isArray(note.tags) || Array.isArray(note.attachments);
}

/**
 * Select the notes that still need migrating to ciphertext - i.e. legacy plaintext
 * (`enc_version == null`). Already-encrypted notes are skipped, which makes the
 * migration idempotent and safe to re-run.
 */
export function notesNeedingMigration<T extends EncryptableNote>(notes: T[]): T[] {
  return notes.filter((n) => n.enc_version == null);
}

function tryDecrypt(token: string, dek: Uint8Array): string {
  // A value that isn't a ciphertext token but arrived under enc_version=1 is mislabeled
  // plaintext (a no-DEK push racing a key clear), not a decrypt failure - pass it through so
  // the note heals instead of showing the placeholder.
  if (!looksLikeCiphertext(token)) return token;
  try {
    return decryptString(token, dek);
  } catch {
    return UNDECRYPTABLE_PLACEHOLDER;
  }
}
