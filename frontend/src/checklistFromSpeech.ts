/**
 * Recognizes a spoken "create me a checklist/to-do list: ..." request and turns it directly
 * into MemoPad's native interactive checklist markup (the same `<ul data-type="taskList">`
 * shape TenTap's TaskList/TaskItem extensions expect - see node_modules/@tiptap/extension-list/
 * src/task-list/task-list.ts and task-item/task-item.ts's renderHTML for the exact tag shape
 * this must match).
 *
 * Deliberately local/deterministic - no AI call. The note editor's mic button already burns one
 * OpenAI round-trip per recording for transcription (Whisper) and, when this doesn't match,
 * another for note-vs-event intent classification; a checklist request has an easily parseable
 * structure ("create a checklist: item, item, item"), so it doesn't need a third AI call just to
 * decide how to format it.
 */

// Matches a leading command like "create me a checklist", "make a to-do list", "start a shopping
// list for groceries:", "...list with apples, bananas". Requires the command to be the
// transcript's own opening, not a lookahead scan - so an unrelated dictation that happens to
// mention "checklist" mid-sentence doesn't misfire.
//
// "for/called/named X:" is treated as a label to discard only when followed by an explicit
// colon (a strong "here's the actual list" signal) - "with" never swallows a label, since
// "...list with apples, bananas" means the items start right there, not that "apples" is a name
// for the list.
const CHECKLIST_TRIGGER =
  /^\s*(?:(?:hey|okay|ok|please|can\s+you|could\s+you)\s+)*(?:create|make|add|start|build)\s+(?:me\s+)?(?:a\s+|an\s+)?(?:to-?\s*do\s*list|checklist|shopping\s*list|task\s*list)\b(?:\s+(?:for|called|named)\s+[^:,\-]+:)?\s*(?:with\s+)?[:,\-]?\s*/i;

export interface ChecklistFromSpeechResult {
  isChecklist: boolean;
  items: string[];
}

/** Split the remainder of a checklist request into individual items - commas, semicolons,
 * newlines, and standalone " and " all count as separators; leading list-numbering/bullet
 * markers on each piece are stripped. */
function splitItems(text: string): string[] {
  if (!text.trim()) return [];
  return text
    .split(/,|;|\n|\s+and\s+/i)
    .map((s) => s.replace(/^\s*(?:\d+[.)]|[-•*])\s*/, '').trim())
    .filter(Boolean);
}

/** Recognize a "create me a checklist ..." style transcript and extract its items. Returns
 * `isChecklist: false` (with an empty items array) when the transcript doesn't open with a
 * checklist-creation phrase - the caller should fall back to normal dictation handling. */
export function parseChecklistFromSpeech(transcript: string): ChecklistFromSpeechResult {
  const text = (transcript || '').trim();
  const match = text.match(CHECKLIST_TRIGGER);
  if (!match) return { isChecklist: false, items: [] };

  const items = splitItems(text.slice(match[0].length));
  // "Create me a checklist" with nothing after it still creates a checklist - just with one
  // empty, ready-to-type item, matching what tapping the toolbar's checklist button does on an
  // empty paragraph.
  return { isChecklist: true, items: items.length > 0 ? items : [''] };
}

function escapeHtml(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Build the TipTap taskList HTML for a set of checklist items - every item starts unchecked. */
export function buildChecklistHtml(items: string[]): string {
  const li = items
    .map(
      (item) =>
        `<li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p>${escapeHtml(item)}</p></div></li>`
    )
    .join('');
  return `<ul data-type="taskList">${li}</ul>`;
}
