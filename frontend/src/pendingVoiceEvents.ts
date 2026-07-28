/**
 * In-process handoff for a voice-intent extraction. The note editor's mic button runs
 * transcription + classification, then (for a non-"note" intent) stages the result here and
 * navigates to /voice-event; that screen `take`s it on mount. Mirrors
 * `share/pendingShareDraft.ts`'s reasoning exactly: route params can't cleanly carry a list of
 * structured events, and a module singleton is fine because the JS runtime is continuous from
 * the editor's navigation call through to the voice-event screen's mount.
 */
import type { VoiceIntentResult } from './types';

export interface PendingVoiceExtraction extends VoiceIntentResult {
  transcript: string;
}

let pending: PendingVoiceExtraction | null = null;

export function setPendingVoiceExtraction(data: PendingVoiceExtraction): void {
  pending = data;
}

/** Return the staged extraction and clear it (single consumer). */
export function takePendingVoiceExtraction(): PendingVoiceExtraction | null {
  const data = pending;
  pending = null;
  return data;
}

export function clearPendingVoiceExtraction(): void {
  pending = null;
}
