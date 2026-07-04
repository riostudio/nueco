/**
 * Best-effort client-side link unfurl for shared social posts — fetch a thumbnail + title
 * WITHOUT a backend. Reliability is platform-specific and honest:
 *
 *   - TikTok      → its PUBLIC oEmbed endpoint (no key): reliable thumbnail + title.
 *   - Instagram / Facebook / Threads → scrape Open Graph tags. These gate logged-out requests
 *     behind a login wall, so og:image/og:title are usually absent; the caller keeps its
 *     badge+caption card when nothing comes back.
 *
 * The network call lives in `unfurl()`; the parsing (`parseTikTokOEmbed`, `parseOpenGraph`) is
 * pure and unit-tested. The card renders instantly; the caller fetches in the background and
 * fills the thumbnail/title in when (if) it resolves.
 */

import { decodeEntities } from '../textContent';

export interface UnfurlResult {
  title?: string;
  thumbnailUrl?: string;
}

const UNFURL_PLATFORMS = new Set(['tiktok', 'instagram', 'facebook', 'threads']);

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
  // TikTok titles arrive with HTML entities (e.g. &#39;, &#128512;) — decode them.
  if (typeof j.title === 'string' && j.title.trim()) out.title = decodeEntities(j.title.trim());
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
    // Instagram / Facebook / Threads: best-effort Open Graph scrape (usually gated).
    const res = await fetchImpl(url, { headers: { 'User-Agent': 'facebookexternalhit/1.1' } });
    if (!res.ok) return {};
    return parseOpenGraph(await res.text());
  } catch {
    return {};
  }
}
