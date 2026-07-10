/**
 * Portable core for calendar event field encryption (Stage 5). Depends only on the
 * E2EE primitives - no keystore, no Expo, no React Native - so it runs under plain
 * Node for unit tests, exactly like `noteCryptoCore.ts`. The device/flag wiring lives
 * in `eventCrypto.ts`, which imports these.
 *
 * What gets encrypted: `title`, `description`, `location`. `start_time`, `end_time`,
 * `reminder_minutes`, `linked_note_ids`, and `device_calendar_event_id` stay
 * plaintext - they're needed for scheduling, reminders, and calendar-sync matching.
 * Encrypted events carry `enc_version = 1`; plaintext (legacy / pre-migration) events
 * have `enc_version == null` and pass through untouched, so a mixed server state
 * during migration always renders correctly.
 */
import { encryptString, decryptString, ENC_VERSION } from './e2ee';

/** Shown in place of a field we hold ciphertext for but cannot decrypt (wrong key /
 * tamper / corruption). Never crash the list over one bad event. */
export const UNDECRYPTABLE_PLACEHOLDER = '⚠️ Unable to decrypt';

/** The encryptable subset of a calendar event. Extra fields are preserved untouched
 * (deliberately no index signature here - it would force every caller's concrete event
 * type, e.g. CalendarEvent, to also declare one just to satisfy this generic constraint). */
export interface EncryptableEvent {
  title?: string;
  description?: string;
  location?: string;
  enc_version?: number | null;
}

/**
 * Encrypt an event's plaintext fields under `dek` and stamp `enc_version`. Only the
 * fields actually present are encrypted (so a reminder-only or linked_note_ids-only
 * update payload stays partial). Idempotent guard: an already-encrypted payload
 * (enc_version === ENC_VERSION) is returned unchanged, so this can never double-encrypt.
 */
export function encryptEventFields<T extends EncryptableEvent>(
  event: T,
  dek: Uint8Array,
): T & { enc_version?: number } {
  if (event.enc_version === ENC_VERSION) return event as T & { enc_version?: number }; // already encrypted - never re-wrap

  const hasTitle = typeof event.title === 'string';
  const hasDescription = typeof event.description === 'string';
  const hasLocation = typeof event.location === 'string';
  // A payload carrying none of the encryptable fields (e.g. a reminder_minutes- or
  // linked_note_ids-only update) must NOT claim the event is encrypted - leaving
  // enc_version unset means the backend (which uses exclude_unset) preserves the
  // stored value.
  if (!hasTitle && !hasDescription && !hasLocation) return event as T & { enc_version?: number };

  const out: EncryptableEvent = { ...event, enc_version: ENC_VERSION };
  if (hasTitle) out.title = encryptString(event.title as string, dek);
  if (hasDescription) out.description = encryptString(event.description as string, dek);
  if (hasLocation) out.location = encryptString(event.location as string, dek);
  return out as T & { enc_version: number };
}

/**
 * Decrypt an event that came from the server. Plaintext events (enc_version !=
 * ENC_VERSION) pass straight through. A field that fails to decrypt is replaced
 * with a placeholder rather than throwing, so one corrupt event can't blank the list.
 * The returned event has `enc_version` cleared, marking it as decrypted plaintext
 * for in-app use.
 */
export function decryptEventFields<T extends EncryptableEvent>(
  event: T,
  dek: Uint8Array,
): T & { enc_version?: number | null } {
  if (event.enc_version !== ENC_VERSION) return event as T & { enc_version?: number | null }; // legacy plaintext - nothing to do

  const safe = (token: unknown): string =>
    typeof token === 'string' ? tryDecrypt(token, dek) : (token as string);

  const out: EncryptableEvent = { ...event, enc_version: null };
  if (typeof event.title === 'string') out.title = safe(event.title);
  if (typeof event.description === 'string') out.description = safe(event.description);
  if (typeof event.location === 'string') out.location = safe(event.location);
  return out as T & { enc_version: number | null };
}

/**
 * True when a payload carries at least one encryptable field. `encryptEventFields`
 * itself already handles field-less payloads; exposed for callers that want to know
 * whether encryption applies before doing other work.
 */
export function hasEncryptableFields(event: EncryptableEvent): boolean {
  return typeof event.title === 'string' || typeof event.description === 'string' || typeof event.location === 'string';
}

/**
 * Select the events that still need migrating to ciphertext - i.e. legacy plaintext
 * (`enc_version == null`). Already-encrypted events are skipped, which makes the
 * migration idempotent and safe to re-run.
 */
export function eventsNeedingMigration<T extends EncryptableEvent>(events: T[]): T[] {
  return events.filter((e) => e.enc_version == null);
}

function tryDecrypt(token: string, dek: Uint8Array): string {
  try {
    return decryptString(token, dek);
  } catch {
    return UNDECRYPTABLE_PLACEHOLDER;
  }
}
