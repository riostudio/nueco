/**
 * Parses the constrained HTML the smart_format backend returns into plain blocks a native (non
 * webview) surface can render - the onboarding reveal preview. Pure logic: no RN imports.
 *
 * The prompt (backend/textai/service.py SMART_FORMAT_PROMPT_TEMPLATE) constrains output to
 * <p>, <h3>, <ul>/<ol> with <li>; anything else is stripped to its text. Unparseable input
 * degrades to a single paragraph of the stripped text - never throws, never drops words.
 */

export interface StructuredBlock {
  kind: 'heading' | 'bullet' | 'numbered' | 'paragraph';
  text: string;
}

const ENTITY_MAP: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code) => {
      try { return String.fromCodePoint(Number(code)); } catch { return ''; }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return ''; }
    })
    .replace(/&([a-zA-Z]+);/g, (m, name) => ENTITY_MAP[name.toLowerCase()] ?? m);
}

/** Inline markup (strong/em/etc.) becomes plain text; <br> becomes a newline. */
export function stripInlineTags(html: string): string {
  return decodeEntities(
    (html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, ''),
  ).replace(/\s*\n\s*/g, '\n').trim();
}

function listItems(listHtml: string): string[] {
  const items: string[] = [];
  const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let m: RegExpExecArray | null;
  while ((m = liRegex.exec(listHtml)) !== null) {
    const text = stripInlineTags(m[1]);
    if (text) items.push(text);
  }
  if (items.length === 0) {
    // Malformed list (no closing </li>): fall back to splitting on opening tags.
    const fallback = stripInlineTags(listHtml.replace(/<li[^>]*>/gi, '\n'));
    for (const line of fallback.split('\n')) {
      if (line.trim()) items.push(line.trim());
    }
  }
  return items;
}

export function parseStructuredHtml(html: string): StructuredBlock[] {
  const source = (html || '').trim();
  if (!source) return [];

  const blocks: StructuredBlock[] = [];
  const token = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>|<(ul|ol)[^>]*>([\s\S]*?)<\/\2>|<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m: RegExpExecArray | null;
  let matched = false;
  while ((m = token.exec(source)) !== null) {
    matched = true;
    if (m[1] !== undefined) {
      const text = stripInlineTags(m[1]);
      if (text) blocks.push({ kind: 'heading', text });
    } else if (m[2] !== undefined) {
      const kind = m[2].toLowerCase() === 'ol' ? 'numbered' : 'bullet';
      for (const text of listItems(m[3])) blocks.push({ kind, text });
    } else if (m[4] !== undefined) {
      const text = stripInlineTags(m[4]);
      if (text) blocks.push({ kind: 'paragraph', text });
    }
  }

  if (!matched) {
    const text = stripInlineTags(source);
    if (text) blocks.push({ kind: 'paragraph', text });
  }
  return blocks;
}
