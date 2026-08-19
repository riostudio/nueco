/**
 * Audio retention policy (plan.md M5). Pure logic - no react/expo imports.
 *
 * Rule behind the defaults: your own voice is yours to keep, but by default it isn't kept
 * for long. Local recordings expire on a rolling window; the user can shorten the window
 * to immediate deletion or lift it entirely ("keep until deleted"). Conversation-mode
 * recordings get a stricter ceiling elsewhere (24h) because they contain other people's
 * voices (plan.md M8).
 */

export type RetentionPref = 'immediate' | '30d' | 'indefinite';

export const DEFAULT_RETENTION: RetentionPref = '30d';

/** One word with its timing, as returned by providers that supply word-level timestamps
 * (Speechmatics). Powers the note editor player's tap-to-seek transcript (plan.md M6). */
export interface WordTiming {
  word: string;
  start: number;
  end: number;
  /** Speaker label when diarization was on (conversation mode). */
  speaker?: string;
  /** Provider confidence 0..1 when available; used to surface low-confidence segments. */
  confidence?: number;
}

export const RETENTION_OPTIONS: { value: RetentionPref; label: string; detail: string }[] = [
  { value: 'immediate', label: 'Delete after transcription', detail: 'Audio is removed as soon as the words are captured' },
  { value: '30d', label: 'Keep for 30 days', detail: 'Recordings roll off after a month' },
  { value: 'indefinite', label: 'Keep until I delete them', detail: 'Recordings stay on this device until removed' },
];

export interface AudioFileRecord {
  id: string;
  /** Set once the recording belongs to a saved note; undefined while freshly captured. */
  noteId?: string;
  uri: string;
  /** Epoch ms when the capture completed. */
  createdAt: number;
  /** Epoch ms when transcription finished, once done. 'immediate' retention waits for this:
   * deleting before the words are captured would lose the user's dictation. */
  transcribedAt?: number;
  sizeBytes?: number;
  /** Conversation-mode captures carry other people's voices and expire within 24h
   * regardless of the user's general preference (plan.md M8 retention inversion). */
  conversation?: boolean;
  /** Word-level timings when the provider supplied them; absent for text-only providers. */
  words?: WordTiming[];
  /** Total audio length in seconds once known, so the player can render duration before load. */
  durationSeconds?: number;
  /** The full transcript string, kept locally (like the audio) so a reopened note can show and
   * export its words even when the provider was text-only and supplied no timings. */
  transcriptText?: string;
}

const DAY_MS = 24 * 3600 * 1000;
export const CONVERSATION_RETENTION_MS = DAY_MS;

/** How long a recording with this preference lives, or null when it never expires on its own. */
export function retentionMs(pref: RetentionPref, record?: AudioFileRecord): number | null {
  // Conversation recordings always honor the 24h ceiling, even under "indefinite".
  if (record?.conversation) return CONVERSATION_RETENTION_MS;
  switch (pref) {
    case 'immediate': return 0;
    case '30d': return 30 * DAY_MS;
    case 'indefinite': return null;
  }
}

export function isExpired(record: AudioFileRecord, pref: RetentionPref, nowMs: number): boolean {
  // "Immediate" means "as soon as the words are captured" - never before transcription
  // exists, or a sweep could delete what the user just said.
  if (pref === 'immediate' && !record.conversation) return record.transcribedAt != null;
  const ttl = retentionMs(pref, record);
  if (ttl === null) return false;
  return nowMs - record.createdAt >= ttl;
}

export function findExpired(records: AudioFileRecord[], pref: RetentionPref, nowMs: number): AudioFileRecord[] {
  return records.filter(r => isExpired(r, pref, nowMs));
}

/** Records that will expire within `withinMs` - used to warn before edited/starred notes
 * lose their audio (plan.md M6 expiry warnings). */
export function findExpiringSoon(
  records: AudioFileRecord[],
  pref: RetentionPref,
  nowMs: number,
  withinMs: number,
): AudioFileRecord[] {
  return records.filter(r => {
    const ttl = retentionMs(pref, r);
    if (ttl === null) return false;
    const remaining = r.createdAt + ttl - nowMs;
    return remaining > 0 && remaining <= withinMs;
  });
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

/** Seconds -> "m:ss" for the player's elapsed/total labels. Negative/NaN render as 0:00. */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
