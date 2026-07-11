/**
 * In-process handoff for a shared note draft. Route params can't carry base64 images /
 * attachment metadata, so the ShareIntentHandler stages the normalized draft here and
 * navigates to the editor with `?shared=1`; the editor `take`s it on mount.
 *
 * A module singleton is enough: the JS runtime is continuous from the share handoff
 * through to the editor mount (cold start, background, and foreground alike).
 */
import type { NoteDraft } from './normalizeShareIntent';

let pending: NoteDraft | null = null;

export function setPendingShareDraft(draft: NoteDraft): void {
  pending = draft;
}

/** Return the staged draft and clear it (single consumer). */
export function takePendingShareDraft(): NoteDraft | null {
  const draft = pending;
  pending = null;
  return draft;
}

export function clearPendingShareDraft(): void {
  pending = null;
}

export function hasPendingShareDraft(): boolean {
  return pending !== null;
}

/** Look at the staged draft without consuming it (for a preview UI). */
export function peekPendingShareDraft(): NoteDraft | null {
  return pending;
}
