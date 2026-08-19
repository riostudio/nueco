/**
 * Deterministic on-device fallback for the cloud smart_format pass, used when the backend's
 * LLM quota is exhausted (OpenAI 429) while the device is online. A real transcript keeps its
 * raw words either way - this only decides whether the capture is shaped like a checklist and
 * can be formatted locally with zero AI. Anything that isn't checklist-shaped returns null and
 * the caller keeps the raw text, exactly like a structuring skip.
 *
 * Pure logic: no react/react-native/expo imports (AGENTS.md layering rule).
 */
import { parseChecklistFromSpeech, buildChecklistHtml } from '../checklistFromSpeech';

/** Returns formatted HTML when local rules can stand in for smart_format, else null.
 * Checklist-shaped captures become interactive taskList markup (same shape the toolbar's
 * checklist button produces); the empty-checklist case returns null so an empty checkbox
 * never masquerades as a captured item. */
export function formatTextLocally(rawText: string): string | null {
  const parsed = parseChecklistFromSpeech(rawText);
  if (parsed.isChecklist && parsed.items.some(i => i.trim() !== '')) {
    return buildChecklistHtml(parsed.items);
  }
  return null;
}
