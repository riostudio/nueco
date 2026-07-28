/**
 * In-process handoff for a hand-drawn sketch. Route params can't carry a base64 PNG data URI
 * cleanly, so /sketch stages the exported image here and navigates back; the editor `take`s it
 * on focus. Mirrors `share/pendingShareDraft.ts`'s reasoning exactly: a module singleton is fine
 * because the JS runtime is continuous from the sketch screen's export through to the editor
 * regaining focus.
 */
let pending: string | null = null;

export function setPendingSketch(dataUri: string): void {
  pending = dataUri;
}

/** Return the staged sketch and clear it (single consumer). */
export function takePendingSketch(): string | null {
  const dataUri = pending;
  pending = null;
  return dataUri;
}
