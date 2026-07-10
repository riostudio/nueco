/**
 * Note content ↔ plain text. Notes now store rich HTML (from the TenTap editor); older notes are
 * plain text with legacy markdown markers. This module renders either into a clean single string for
 * list previews, search, and share text - and is the single home for HTML-entity decoding (also used
 * by the link-unfurl parser).
 *
 * Pure + node-testable: no react-native imports.
 */
import { stripSourceMarker } from './share/socialSource';

/** A single code point → string, guarding against out-of-range values. */
export function codePoint(n: number): string {
  try {
    return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  } catch {
    return '';
  }
}

/** Decode HTML entities: numeric (decimal &#233; and hex &#x1F600;) plus common named ones. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => codePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&'); // decode &amp; last so we don't double-decode
}

/**
 * Plain text (shared/dictated) → HTML for the rich-text editor, preserving structure: a blank line
 * starts a new paragraph and a single newline becomes a <br>. HTML-escapes the text so it renders
 * literally and can't inject markup. Roughly the inverse of plainTextFromContent - used so shared
 * text keeps its line breaks/paragraphs instead of collapsing when dropped into the HTML editor.
 */
export function textToHtml(text: string): string {
  const clean = (text || '').replace(/\r\n?/g, '\n').trim();
  if (!clean) return '';
  const escape = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return clean
    .split(/\n{2,}/)
    .map((para) => `<p>${escape(para).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/**
 * Note content (rich HTML for new notes, plain text for legacy ones) → clean plain text for previews,
 * search, and share. Strips the shared-post marker, turns block boundaries into newlines, drops tags,
 * decodes entities, and clears leftover legacy markdown.
 */
export function plainTextFromContent(content: string): string {
  let s = stripSourceMarker(content || '');
  // Block boundaries → newlines so words don't run together.
  s = s.replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n');
  // Drop all remaining tags (and any stray HTML comments).
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  // Legacy markdown markers from old plain-text notes.
  s = s.replace(/\*\*/g, '').replace(/\*/g, '').replace(/^[-•]\s+/gm, '');
  // Collapse whitespace.
  return s.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}
