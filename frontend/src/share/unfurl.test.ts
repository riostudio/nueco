/**
 * Unit tests for the client-side unfurl helpers. Framework-free:
 *   node --import ./src/crypto/_ts-resolver.mjs src/share/unfurl.test.ts
 * The network call is stubbed via an injected fetch.
 */
import { parseTikTokOEmbed, parseOpenGraph, parseRedditJson, redditJsonUrl, needsUnfurl, unfurl } from './unfurl.ts';

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, detail); }
}

async function main() {
  console.log('needsUnfurl:');
  {
    ok('tiktok', needsUnfurl('tiktok'));
    ok('reddit', needsUnfurl('reddit'));
    ok('instagram', needsUnfurl('instagram'));
    ok('facebook', needsUnfurl('facebook'));
    ok('threads', needsUnfurl('threads'));
    ok('linkedin', needsUnfurl('linkedin'));
    ok('youtube → no (derivable poster)', !needsUnfurl('youtube'));
    ok('generic link → no', !needsUnfurl('link'));
  }

  console.log('redditJsonUrl:');
  {
    ok('reddit.com post → .json', redditJsonUrl('https://www.reddit.com/r/aww/comments/abc/a_cute_dog/') === 'https://www.reddit.com/r/aww/comments/abc/a_cute_dog.json?raw_json=1',
      redditJsonUrl('https://www.reddit.com/r/aww/comments/abc/a_cute_dog/') || 'null');
    ok('redd.it short → /comments/<id>', redditJsonUrl('https://redd.it/xyz123') === 'https://www.reddit.com/comments/xyz123.json?raw_json=1',
      redditJsonUrl('https://redd.it/xyz123') || 'null');
    ok('garbage → null', redditJsonUrl('not a url') === null);
  }

  console.log('parseRedditJson:');
  {
    const listing = (post: Record<string, unknown>) => [{ data: { children: [{ data: post }] } }];
    const r = parseRedditJson(listing({
      title: 'A cute &amp; fluffy dog',
      post_hint: 'image',
      preview: { images: [{ source: { url: 'https://preview.redd.it/x.jpg?width=1080&amp;s=abc' } }] },
    }));
    ok('title decoded', r.title === 'A cute & fluffy dog', r.title);
    ok('preview poster used + decoded', r.thumbnailUrl === 'https://preview.redd.it/x.jpg?width=1080&s=abc', r.thumbnailUrl);
    ok('image kind', r.kind === 'image', r.kind);

    const vid = parseRedditJson(listing({
      title: 'clip', is_video: true,
      preview: { images: [{ source: { url: 'https://preview.redd.it/v.jpg' } }] },
    }));
    ok('video kind (is_video)', vid.kind === 'video', vid.kind);

    const dest = parseRedditJson(listing({ title: 't', url_overridden_by_dest: 'https://i.redd.it/pic.png' }));
    ok('falls back to image dest', dest.thumbnailUrl === 'https://i.redd.it/pic.png', dest.thumbnailUrl);

    const placeholder = parseRedditJson(listing({ title: 't', thumbnail: 'self' }));
    ok('placeholder thumbnail ignored', placeholder.thumbnailUrl === undefined, placeholder.thumbnailUrl);

    ok('malformed → {}', Object.keys(parseRedditJson({ nope: 1 })).length === 0);
    ok('null → {}', Object.keys(parseRedditJson(null)).length === 0);
  }

  console.log('parseTikTokOEmbed:');
  {
    const r = parseTikTokOEmbed({ thumbnail_url: 'https://cdn/t.jpg', title: 'Funny clip' });
    ok('thumbnail', r.thumbnailUrl === 'https://cdn/t.jpg');
    ok('title', r.title === 'Funny clip');
    ok('null → {}', Object.keys(parseTikTokOEmbed(null)).length === 0);
    ok('missing fields → {}', Object.keys(parseTikTokOEmbed({})).length === 0);
    // TikTok titles carry HTML entities — decode decimal + apostrophe + emoji.
    ok('decodes entities in title', parseTikTokOEmbed({ title: 'It&#39;s a caf&#233; &#128512;' }).title === "It's a café 😀",
      parseTikTokOEmbed({ title: 'It&#39;s a caf&#233; &#128512;' }).title);
  }

  console.log('decodeEntities (via parseOpenGraph title):');
  {
    ok('decimal → é', parseOpenGraph('<meta property="og:title" content="Caf&#233;">').title === 'Café');
    ok('decimal emoji', parseOpenGraph('<meta property="og:title" content="Hi &#128512;">').title === 'Hi 😀');
    ok('hex emoji', parseOpenGraph('<meta property="og:title" content="Hi &#x1F600;">').title === 'Hi 😀');
    ok('named + amp last', parseOpenGraph('<meta property="og:title" content="A &amp; B &lt;3">').title === 'A & B <3');
    ok('apostrophe entity', parseOpenGraph("<meta property=\"og:title\" content=\"It&#39;s\">").title === "It's");
  }

  console.log('parseOpenGraph:');
  {
    const html = '<html><head>'
      + '<meta property="og:title" content="Cool &amp; Post">'
      + '<meta property="og:image" content="https://cdn/i.jpg?a=1&amp;b=2">'
      + '</head></html>';
    const r = parseOpenGraph(html);
    ok('og:title decoded', r.title === 'Cool & Post', r.title);
    ok('og:image decoded', r.thumbnailUrl === 'https://cdn/i.jpg?a=1&b=2', r.thumbnailUrl);

    const tw = parseOpenGraph('<meta name="twitter:image" content="https://cdn/tw.jpg"><meta name="twitter:title" content="Tw">');
    ok('twitter:image fallback', tw.thumbnailUrl === 'https://cdn/tw.jpg');
    ok('twitter:title fallback', tw.title === 'Tw');

    ok('no meta tags → {}', Object.keys(parseOpenGraph('<html></html>')).length === 0);
    ok('attr order-independent', parseOpenGraph('<meta content="https://cdn/x.jpg" property="og:image">').thumbnailUrl === 'https://cdn/x.jpg');
    ok('single-quoted attrs', parseOpenGraph("<meta property='og:image' content='https://cdn/sq.jpg'>").thumbnailUrl === 'https://cdn/sq.jpg');
    ok('first og:image wins', parseOpenGraph('<meta property="og:image" content="a"><meta property="og:image" content="b">').thumbnailUrl === 'a');
  }

  console.log('unfurl (injected fetch):');
  {
    const tiktokFetch = (async () => ({ ok: true, json: async () => ({ thumbnail_url: 'https://cdn/tk.jpg', title: 'TT' }) })) as unknown as typeof fetch;
    const r = await unfurl('https://www.tiktok.com/@x/video/1', 'tiktok', tiktokFetch);
    ok('tiktok via oembed', r.thumbnailUrl === 'https://cdn/tk.jpg' && r.title === 'TT');

    const ogFetch = (async () => ({ ok: true, text: async () => '<meta property="og:image" content="https://cdn/ig.jpg">' })) as unknown as typeof fetch;
    const r2 = await unfurl('https://instagram.com/p/x', 'instagram', ogFetch);
    ok('instagram via og scrape', r2.thumbnailUrl === 'https://cdn/ig.jpg');

    // LinkedIn shares the OG-scrape path (best-effort; usually gated in the wild).
    const li = await unfurl('https://www.linkedin.com/posts/x', 'linkedin',
      (async () => ({ ok: true, text: async () => '<meta property="og:title" content="LI Post">' })) as unknown as typeof fetch);
    ok('linkedin via og scrape', li.title === 'LI Post');

    const redditFetch = (async (u: string) => {
      ok('reddit hits .json api', typeof u === 'string' && u.includes('/comments/r1.json'));
      return { ok: true, json: async () => [{ data: { children: [{ data: { title: 'RD', is_video: true, preview: { images: [{ source: { url: 'https://preview.redd.it/r.jpg' } }] } } }] } }] };
    }) as unknown as typeof fetch;
    const r3 = await unfurl('https://redd.it/r1', 'reddit', redditFetch);
    ok('reddit via json api', r3.title === 'RD' && r3.thumbnailUrl === 'https://preview.redd.it/r.jpg' && r3.kind === 'video');

    const failFetch = (async () => ({ ok: false })) as unknown as typeof fetch;
    ok('non-ok response → {}', Object.keys(await unfurl('https://x', 'tiktok', failFetch)).length === 0);

    const throwFetch = (async () => { throw new Error('net'); }) as unknown as typeof fetch;
    ok('fetch throws → {} (never throws)', Object.keys(await unfurl('https://x', 'instagram', throwFetch)).length === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
