/**
 * Best-effort client-side link unfurl for shared social posts - fetch a thumbnail + title
 * WITHOUT a backend. Reliability is platform-specific and honest:
 *
 *   - TikTok      → its PUBLIC oEmbed endpoint (no key): reliable thumbnail + title.
 *   - Reddit      → its PUBLIC `.json` API (no key): reliable title + preview poster, and a
 *     video/image `kind` hint so video posts get the play overlay.
 *   - Instagram / Facebook / Threads / LinkedIn → scrape Open Graph tags. These gate
 *     logged-out requests behind a login wall, so og:image/og:title are usually absent; the
 *     caller keeps its badge+caption card when nothing comes back. (LinkedIn especially.)
 *   - Any other link (the generic `link` platform - includes AI-tool share pages like
 *     claude.ai/share/…, chatgpt.com/share/…, perplexity.ai/search/…) → the same Open Graph
 *     scrape. Unlike the gated platforms above, most of these expose og:title/og:image freely,
 *     since the page is meant to be publicly shareable.
 *
 * The network call lives in `unfurl()`; the parsing (`parseTikTokOEmbed`, `parseRedditJson`,
 * `parseOpenGraph`) is pure and unit-tested. The card renders instantly; the caller fetches in
 * the background and fills the thumbnail/title in when (if) it resolves.
 */

import { decodeEntities } from '../textContent';

export interface UnfurlResult {
  title?: string;
  thumbnailUrl?: string;
  kind?: 'image' | 'video'; // card treatment hint (video → play overlay); set by Reddit only
}

const UNFURL_PLATFORMS = new Set(['tiktok', 'reddit', 'instagram', 'facebook', 'threads', 'linkedin', 'link']);

// Reddit blocks generic/empty User-Agents (429s); a descriptive UA keeps the `.json` API happy.
const REDDIT_UA = 'MemoPad/1.0 (link unfurl)';

/** Platforms we attempt to unfurl client-side (see reliability note above). */
export function needsUnfurl(platform: string): boolean {
  return UNFURL_PLATFORMS.has(platform);
}

/** Parse a TikTok oEmbed JSON response → thumbnail + title. */
export function parseTikTokOEmbed(json: unknown): UnfurlResult {
  const out: UnfurlResult = {};
  if (!json || typeof json !== 'object') return out;
  const j = json as Record<string, unknown>;
  if (typeof j.thumbnail_url === 'string' && j.thumbnail_url) out.thumbnailUrl = j.thumbnail_url;
  // TikTok titles arrive with HTML entities (e.g. &#39;, &#128512;) - decode them.
  if (typeof j.title === 'string' && j.title.trim()) out.title = decodeEntities(j.title.trim());
  return out;
}

/** True when a URL points at an image file (by extension) or Reddit's image CDN. */
function isImageUrl(u: string): boolean {
  return /\.(jpe?g|png|gif|webp|bmp)(\?|#|$)/i.test(u) || /:\/\/i\.redd\.it\//i.test(u);
}

/**
 * Build the Reddit public JSON endpoint for a shared post URL, or null if it isn't one we can
 * resolve. `redd.it/<id>` short links map to `/comments/<id>`; `reddit.com/...` paths just get
 * `.json` appended. `raw_json=1` returns unescaped URLs.
 */
export function redditJsonUrl(url: string): string | null {
  try {
    const u = new URL(url.trim());
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'redd.it') {
      const id = u.pathname.replace(/^\/+/, '').split('/')[0];
      return id ? `https://www.reddit.com/comments/${id}.json?raw_json=1` : null;
    }
    const path = u.pathname.replace(/\/+$/, '');
    if (!path) return null;
    return `https://www.reddit.com${path}.json?raw_json=1`;
  } catch {
    return null;
  }
}

/** Parse a Reddit `.json` post-listing response → title + preview thumbnail + image/video kind. */
export function parseRedditJson(json: unknown): UnfurlResult {
  const out: UnfurlResult = {};
  const listing = Array.isArray(json) ? json[0] : json;
  const post = (listing as any)?.data?.children?.[0]?.data;
  if (!post || typeof post !== 'object') return out;

  if (typeof post.title === 'string' && post.title.trim()) out.title = decodeEntities(post.title.trim());

  // Thumbnail: prefer the high-res preview poster, then a direct image dest, then the small thumb.
  // (`thumbnail` is often a placeholder like 'self'/'default'/'nsfw', so require an http URL.)
  let thumb: string | undefined;
  const previewUrl = post.preview?.images?.[0]?.source?.url;
  if (typeof previewUrl === 'string' && previewUrl) thumb = previewUrl;
  else if (typeof post.url_overridden_by_dest === 'string' && isImageUrl(post.url_overridden_by_dest)) thumb = post.url_overridden_by_dest;
  else if (typeof post.thumbnail === 'string' && /^https?:\/\//.test(post.thumbnail)) thumb = post.thumbnail;
  if (thumb) out.thumbnailUrl = decodeEntities(thumb);

  // Kind: video posts get the play overlay; image posts stay image; otherwise leave to the caller.
  const hint = typeof post.post_hint === 'string' ? post.post_hint : '';
  if (post.is_video === true || hint === 'hosted:video' || hint === 'rich:video' || post.media?.reddit_video || post.preview?.reddit_video_preview) {
    out.kind = 'video';
  } else if (hint === 'image' || (thumb && isImageUrl(thumb))) {
    out.kind = 'image';
  }
  return out;
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? (m[2] ?? m[3]) : undefined;
}

/** Extract og:image / og:title (falling back to twitter:*) from a page's HTML. */
export function parseOpenGraph(html: string): UnfurlResult {
  const out: UnfurlResult = {};
  const metaRe = /<meta\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = metaRe.exec(html)) !== null) {
    const tag = m[0];
    const key = (attr(tag, 'property') || attr(tag, 'name') || '').toLowerCase();
    if (!key) continue;
    const content = attr(tag, 'content');
    if (!content) continue;
    if (!out.thumbnailUrl && (key === 'og:image' || key === 'og:image:secure_url' || key === 'twitter:image')) {
      out.thumbnailUrl = decodeEntities(content);
    } else if (!out.title && (key === 'og:title' || key === 'twitter:title')) {
      out.title = decodeEntities(content);
    }
  }
  return out;
}

/**
 * Fetch a thumbnail + title for a shared post. Returns `{}` on any failure (never throws), so
 * the caller simply keeps its existing card. `fetchImpl` is injectable for tests.
 */
export async function unfurl(url: string, platform: string, fetchImpl: typeof fetch = fetch): Promise<UnfurlResult> {
  try {
    if (platform === 'tiktok') {
      const res = await fetchImpl(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`);
      if (!res.ok) return {};
      return parseTikTokOEmbed(await res.json());
    }
    if (platform === 'reddit') {
      const api = redditJsonUrl(url);
      if (!api) return {};
      const res = await fetchImpl(api, { headers: { 'User-Agent': REDDIT_UA } });
      if (!res.ok) return {};
      return parseRedditJson(await res.json());
    }
    // Everything else (Instagram/Facebook/Threads/LinkedIn - usually gated - and any generic
    // link, which usually isn't): best-effort Open Graph scrape.
    const res = await fetchImpl(url, { headers: { 'User-Agent': 'facebookexternalhit/1.1' } });
    if (!res.ok) return {};
    return parseOpenGraph(await res.text());
  } catch {
    return {};
  }
}
