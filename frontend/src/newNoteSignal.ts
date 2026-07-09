/**
 * One-shot hand-off between the editor and the notes list: when the editor creates a brand-new note,
 * it records the id here; the notes list reads (and clears) it on focus to play a one-time "newly
 * created" glow on that card. Module-level state — both screens share the same JS context.
 */
let _newNoteId: string | null = null;

export function setNewNoteId(id: string): void {
  _newNoteId = id;
}

/** Return the pending new-note id (if any) and clear it, so the glow only plays once. */
export function takeNewNoteId(): string | null {
  const id = _newNoteId;
  _newNoteId = null;
  return id;
}
