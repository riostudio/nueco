/**
 * Conversation-mode policy logic (plan.md M8). Pure logic - no react/expo imports.
 *
 * Conversation mode is ENABLED for testing (gate flipped by the product owner). Legal review
 * of multi-party recording remains the owner's responsibility before public release; nothing
 * here should attempt jurisdiction-specific legal guidance.
 *
 * Capability honesty (plan/10): overlapped speech cannot be transcribed accurately by any
 * available ASR. The design response is "fail visibly" - detect likely-overlap regions from the
 * diarizer's word timings and mark them instead of emitting a confident single-speaker transcript.
 */
import type { WordTiming } from './retention';

/** Feature gate - flipped on by the product owner. The M8 legal review remains the owner's
 * responsibility; the app intentionally gives no jurisdiction-specific legal guidance. */
export const CONVERSATION_MODE_ENABLED = true;

/** Session length cap (spec: 45 to 60 minutes). */
export const MAX_CONVERSATION_MINUTES = 45;
export const MAX_CONVERSATION_MS = MAX_CONVERSATION_MINUTES * 60 * 1000;

/** A local-only record of the per-session attestation (plan/11). Never leaves the device. */
export interface ConsentRecord {
  /** Epoch ms when the prompt was answered. */
  attestedAt: number;
  /** 'confirmed' = "Yes, start recording"; 'declined' = "Not yet". */
  choice: 'confirmed' | 'declined';
  /** Whether the optional audible announcement ("Recording started for note-taking") played. */
  announcementPlayed: boolean;
}

export function isSessionOverCap(elapsedMs: number): boolean {
  return elapsedMs >= MAX_CONVERSATION_MS;
}

/** Seconds remaining before the session cap, floored at 0. */
export function conversationSecondsLeft(elapsedMs: number): number {
  return Math.max(0, Math.ceil((MAX_CONVERSATION_MS - elapsedMs) / 1000));
}

/** A region of the transcript flagged as likely overlap or unattributable. */
export interface FlaggedRegion {
  /** Index into the words array of the first word in the region. */
  startWord: number;
  /** Index of the last word in the region (inclusive). */
  endWord: number;
  reason: 'overlap' | 'low-confidence';
}

// Diarizers assign one speaker per frame, so true overlap shows up in word timings as two
// different speakers whose intervals intersect, or as words with no speaker at all. Neither
// signal is conclusive - that is exactly why flagged regions are marked, never silently
// attributed (plan/10 "mark, do not fabricate").
const LOW_CONFIDENCE_THRESHOLD = 0.5;

/**
 * Flag regions that should not be presented as a confident single-speaker transcript:
 *  - words from different speakers whose time intervals overlap (simultaneous speech),
 *  - words missing a speaker label entirely,
 *  - low-confidence words (surfaced per plan/10 "confidence surfacing").
 * Adjacent flagged words merge into one region so the UI renders contiguous blocks; a merged
 * region reports 'overlap' if any word in it was flagged for overlap.
 */
export function flagConversationRegions(words: WordTiming[]): FlaggedRegion[] {
  const reasons = new Map<number, 'overlap' | 'low-confidence'>();
  const flag = (i: number, reason: 'overlap' | 'low-confidence') => {
    // Overlap is the stronger signal - don't let a later low-confidence mark downgrade it.
    if (!reasons.has(i) || reason === 'overlap') reasons.set(i, reason);
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w.speaker) {
      flag(i, 'overlap'); // unattributable audio is treated like overlap: never silently attributed
      continue;
    }
    if (typeof w.confidence === 'number' && w.confidence < LOW_CONFIDENCE_THRESHOLD) {
      flag(i, 'low-confidence');
    }
    // Overlap: this word starts before the previous word (any speaker) ends, and the speakers
    // differ - two voices occupying the same time slice.
    if (i > 0) {
      const prev = words[i - 1];
      if (prev.speaker && prev.speaker !== w.speaker && w.start < prev.end) {
        flag(i, 'overlap');
        flag(i - 1, 'overlap');
      }
    }
  }
  const regions: FlaggedRegion[] = [];
  let start = -1;
  let hasOverlap = false;
  for (let i = 0; i <= words.length; i++) {
    const reason = i < words.length ? reasons.get(i) : undefined;
    if (reason && start === -1) {
      start = i;
      hasOverlap = reason === 'overlap';
    } else if (reason) {
      if (reason === 'overlap') hasOverlap = true;
    } else if (start !== -1) {
      regions.push({ startWord: start, endWord: i - 1, reason: hasOverlap ? 'overlap' : 'low-confidence' });
      start = -1;
      hasOverlap = false;
    }
  }
  return regions;
}

/** Group words into contiguous speaker turns for block display (plan/10 "grouped display"). */
export interface SpeakerTurn {
  speaker: string | null;
  startWord: number;
  endWord: number;
  text: string;
}

export function groupSpeakerTurns(words: WordTiming[]): SpeakerTurn[] {
  const turns: SpeakerTurn[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const last = turns[turns.length - 1];
    if (last && last.speaker === (w.speaker ?? null)) {
      last.endWord = i;
      last.text += (last.text ? ' ' : '') + w.word;
    } else {
      turns.push({ speaker: w.speaker ?? null, startWord: i, endWord: i, text: w.word });
    }
  }
  return turns;
}
