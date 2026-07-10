/**
 * Recognize the social platform behind a shared URL and (de)serialize a compact
 * "shared post" descriptor into the note body.
 *
 * Pure + node-testable: NO react-native / theme imports, so the framework-free test
 * runner (`node src/share/socialSource.test.ts`) can import it. Brand colors are literal
 * hex; the editor card reads them directly.
 *
 * Persistence (frontend-only, no schema change): the durable card data is appended to the
 * note `content` as a single HTML-comment marker, URL-encoded so a caption containing
 * `-->`, `<`, or `>` can never break the delimiter (those chars are percent-escaped). The
 * thumbnail is NOT serialized - it rides in the note's `images[0]` (flagged by `th:1`).
 */

export type SourceKind = 'image' | 'video' | 'link';

/** A social post captured from an OS share, rendered as a card in the editor. */
export interface SourcePost {
  platform: string; // machine id: 'instagram' | 'facebook' | … | 'link'
  label: string; // human label: 'Instagram', or the host for a generic link
  url: string; // links back to the original post
  title: string; // post header / caption (may be '')
  kind: SourceKind; // drives the card's thumbnail treatment
  thumbnail?: string; // data-uri; in-session only, persisted via images[0]
  thumbUrl?: string; // remote poster (e.g. a YouTube CDN frame); persisted in the marker
}

/** Brand presentation for a URL - a recognized platform, or a generic link fallback. */
export interface SourceBrand {
  platform: string;
  label: string;
  brandColor: string; // literal hex
  icon: string; // MaterialCommunityIcons glyph name
}

interface BrandRule extends SourceBrand {
  hosts: RegExp; // tested against the lowercased, de-www'd hostname
}

// Order doesn't matter (host patterns are mutually exclusive). Icons are MaterialCommunityIcons
// glyph names (brand icons ship with @expo/vector-icons).
const BRANDS: BrandRule[] = [
  { platform: 'instagram', label: 'Instagram', brandColor: '#E1306C', icon: 'instagram', hosts: /(^|\.)(instagram\.com|instagr\.am)$/ },
  { platform: 'facebook', label: 'Facebook', brandColor: '#1877F2', icon: 'facebook', hosts: /(^|\.)(facebook\.com|fb\.com|fb\.watch)$/ },
  { platform: 'messenger', label: 'Messenger', brandColor: '#0084FF', icon: 'facebook-messenger', hosts: /(^|\.)(messenger\.com|m\.me)$/ },
  { platform: 'whatsapp', label: 'WhatsApp', brandColor: '#25D366', icon: 'whatsapp', hosts: /(^|\.)(whatsapp\.com|wa\.me)$/ },
  { platform: 'tiktok', label: 'TikTok', brandColor: '#010101', icon: 'music-note', hosts: /(^|\.)(tiktok\.com)$/ },
  { platform: 'youtube', label: 'YouTube', brandColor: '#FF0000', icon: 'youtube', hosts: /(^|\.)(youtube\.com|youtu\.be)$/ },
  { platform: 'x', label: 'X', brandColor: '#000000', icon: 'twitter', hosts: /(^|\.)(twitter\.com|x\.com|t\.co)$/ },
  { platform: 'threads', label: 'Threads', brandColor: '#000000', icon: 'at', hosts: /(^|\.)(threads\.net)$/ },
  { platform: 'reddit', label: 'Reddit', brandColor: '#FF4500', icon: 'reddit', hosts: /(^|\.)(reddit\.com|redd\.it)$/ },
  { platform: 'linkedin', label: 'LinkedIn', brandColor: '#0A66C2', icon: 'linkedin', hosts: /(^|\.)(linkedin\.com|lnkd\.in)$/ },
  { platform: 'pinterest', label: 'Pinterest', brandColor: '#E60023', icon: 'pinterest', hosts: /(^|\.)(pinterest\.com|pin\.it)$/ },
  { platform: 'telegram', label: 'Telegram', brandColor: '#26A5E4', icon: 'send', hosts: /(^|\.)(telegram\.org|t\.me)$/ },
];

const FALLBACK_ICON = 'link-variant';
const FALLBACK_COLOR = '#1565C0'; // == C.secondary

/** Lowercased hostname with a leading `www.` removed; '' when the URL can't be parsed. */
export function hostOf(url: string): string {
  let host = '';
  try {
    host = new URL(url.trim()).hostname;
  } catch {
    // Best-effort for odd inputs: pull the authority out by hand.
    const m = url.trim().match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i);
    host = m ? m[1] : '';
  }
  return host.toLowerCase().replace(/^www\./, '');
}

/** Recognize a platform from a URL. A valid-but-unknown URL gets a generic `link` brand. */
export function detectSocialSource(url: string): SourceBrand | null {
  const host = hostOf(url);
  if (!host) return null;
  for (const b of BRANDS) {
    if (b.hosts.test(host)) {
      return { platform: b.platform, label: b.label, brandColor: b.brandColor, icon: b.icon };
    }
  }
  return { platform: 'link', label: host, brandColor: FALLBACK_COLOR, icon: FALLBACK_ICON };
}

/** True only for a recognized, branded platform (not the generic `link` fallback). */
export function isKnownSocial(url: string): boolean {
  const s = detectSocialSource(url);
  return !!s && s.platform !== 'link';
}

/** Extract an 11-char YouTube video id from any of its URL shapes, or null. */
export function youtubeId(url: string): string | null {
  const host = hostOf(url);
  if (!/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) return null;
  const ID = /^[A-Za-z0-9_-]{11}$/;
  try {
    const u = new URL(url.trim());
    if (host === 'youtu.be') {
      const id = u.pathname.slice(1).split('/')[0];
      return ID.test(id) ? id : null;
    }
    const v = u.searchParams.get('v');
    if (v && ID.test(v)) return v;
    const m = u.pathname.match(/\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * A deterministic poster image for a URL, when one exists without unfurling. Today: YouTube,
 * whose thumbnails live at a predictable CDN path derived from the video id (no scraping).
 */
export function derivePosterUrl(url: string): string | undefined {
  const id = youtubeId(url);
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : undefined;
}

// --- note-body marker (durable card data) ------------------------------------------------

// Payload never contains `\n` or `>` (URL-encoded), so this matches unambiguously at EOL.
const MARKER_RE = /\n*<!--mp-post:([^\n>]*)-->\s*$/;

/** Append the card marker to the note content. `thumbInImages0` records that images[0] is the thumb. */
export function serializeSourcePost(sp: SourcePost | null, thumbInImages0: boolean): string {
  if (!sp) return '';
  const payload: Record<string, unknown> = { p: sp.platform, l: sp.label, u: sp.url, t: sp.title, k: sp.kind, th: thumbInImages0 ? 1 : 0 };
  if (sp.thumbUrl) payload.tu = sp.thumbUrl;
  return `\n\n<!--mp-post:${encodeURIComponent(JSON.stringify(payload))}-->`;
}

export interface ParsedContent {
  sourcePost: SourcePost | null;
  thumbInImages0: boolean;
  content: string; // content with the marker removed
}

/** Split a stored content string into its user-visible body and the card (if any). */
export function parseSourcePost(content: string): ParsedContent {
  const m = content.match(MARKER_RE);
  if (!m) return { sourcePost: null, thumbInImages0: false, content };
  try {
    const j = JSON.parse(decodeURIComponent(m[1]));
    const sp: SourcePost = {
      platform: String(j.p ?? 'link'),
      label: String(j.l ?? ''),
      url: String(j.u ?? ''),
      title: String(j.t ?? ''),
      kind: j.k === 'image' || j.k === 'video' ? j.k : 'link',
      thumbUrl: typeof j.tu === 'string' ? j.tu : undefined,
    };
    return { sourcePost: sp, thumbInImages0: j.th === 1, content: content.slice(0, m.index).replace(/\s+$/, '') };
  } catch {
    // Corrupt marker - leave content untouched rather than lose the user's text.
    return { sourcePost: null, thumbInImages0: false, content };
  }
}

/** Remove the card marker from a content string (for list/search previews). */
export function stripSourceMarker(content: string): string {
  return content.replace(MARKER_RE, '').replace(/\s+$/, '');
}
