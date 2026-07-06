/**
 * Unit tests for socialSource (platform detection + note-body marker). Framework-free:
 *   node src/share/socialSource.test.ts
 * Exits non-zero on any failure.
 */
import {
  detectSocialSource, isKnownSocial, hostOf, youtubeId, derivePosterUrl,
  serializeSourcePost, parseSourcePost, stripSourceMarker,
  type SourcePost,
} from './socialSource.ts';

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, detail); }
}

function main() {
  console.log('platform detection:');
  {
    const cases: [string, string][] = [
      ['https://www.instagram.com/p/abc/', 'instagram'],
      ['https://instagr.am/p/abc', 'instagram'],
      ['https://www.facebook.com/x/posts/1', 'facebook'],
      ['https://fb.watch/xyz', 'facebook'],
      ['https://m.me/someone', 'messenger'],
      ['https://wa.me/123', 'whatsapp'],
      ['https://vt.tiktok.com/abc', 'tiktok'],
      ['https://www.tiktok.com/@u/video/1', 'tiktok'],
      ['https://youtu.be/abc', 'youtube'],
      ['https://www.youtube.com/watch?v=abc', 'youtube'],
      ['https://x.com/u/status/1', 'x'],
      ['https://twitter.com/u/status/1', 'x'],
      ['https://www.reddit.com/r/x/comments/1', 'reddit'],
      ['https://www.linkedin.com/posts/x', 'linkedin'],
      ['https://pin.it/abc', 'pinterest'],
      ['https://t.me/channel/1', 'telegram'],
      ['https://www.threads.net/@u/post/1', 'threads'],
    ];
    for (const [url, plat] of cases) {
      ok(`${url} → ${plat}`, detectSocialSource(url)?.platform === plat, JSON.stringify(detectSocialSource(url)));
    }
    ok('known social flagged', isKnownSocial('https://instagram.com/p/x'));
    ok('unknown host → not "known"', !isKnownSocial('https://example.com/x'));
    const g = detectSocialSource('https://example.com/blog/1');
    ok('generic link: platform=link, label=host', g?.platform === 'link' && g?.label === 'example.com');
    ok('brand carries a color + icon', !!detectSocialSource('https://instagram.com/p/x')?.brandColor && !!detectSocialSource('https://instagram.com/p/x')?.icon);
    ok('invalid url → null', detectSocialSource('not a url') === null);
  }

  console.log('hostOf:');
  {
    ok('strips www', hostOf('https://www.example.com/x') === 'example.com');
    ok('lowercases', hostOf('https://EXAMPLE.com') === 'example.com');
    ok('non-url → empty', hostOf('garbage') === '');
  }

  console.log('youtube poster:');
  {
    ok('watch?v=', youtubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ') === 'dQw4w9WgXcQ');
    ok('youtu.be/', youtubeId('https://youtu.be/dQw4w9WgXcQ') === 'dQw4w9WgXcQ');
    ok('shorts/', youtubeId('https://www.youtube.com/shorts/dQw4w9WgXcQ') === 'dQw4w9WgXcQ');
    ok('embed/', youtubeId('https://www.youtube.com/embed/dQw4w9WgXcQ') === 'dQw4w9WgXcQ');
    ok('watch + extra params', youtubeId('https://youtube.com/watch?v=dQw4w9WgXcQ&t=30s') === 'dQw4w9WgXcQ');
    ok('non-youtube → null', youtubeId('https://vimeo.com/123') === null);
    ok('youtube without id → null', youtubeId('https://www.youtube.com/feed/subscriptions') === null);
    ok('poster derived', derivePosterUrl('https://youtu.be/dQw4w9WgXcQ') === 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
    ok('no poster for generic', derivePosterUrl('https://example.com') === undefined);
  }

  console.log('marker round-trip:');
  {
    const sp: SourcePost = {
      platform: 'instagram', label: 'Instagram', url: 'https://instagram.com/p/x',
      title: 'Sunset 🌇 --> <b>hi</b>', kind: 'image',
    };
    const body = 'my own note';
    const stored = body + serializeSourcePost(sp, true);
    const parsed = parseSourcePost(stored);
    ok('content restored (marker stripped)', parsed.content === body, JSON.stringify(parsed.content));
    ok('platform restored', parsed.sourcePost?.platform === 'instagram');
    ok('url restored', parsed.sourcePost?.url === sp.url);
    ok('title restored (special chars survive)', parsed.sourcePost?.title === sp.title, parsed.sourcePost?.title);
    ok('kind restored', parsed.sourcePost?.kind === 'image');
    ok('thumbInImages0 flag restored', parsed.thumbInImages0 === true);
    ok('thumbnail NOT serialized', parsed.sourcePost?.thumbnail === undefined);
    ok('stripSourceMarker removes marker', stripSourceMarker(stored) === body);
  }

  console.log('marker with remote poster:');
  {
    const sp: SourcePost = {
      platform: 'youtube', label: 'YouTube', url: 'https://youtu.be/x', title: 'Vid',
      kind: 'video', thumbUrl: 'https://i.ytimg.com/vi/x/hqdefault.jpg',
    };
    const parsed = parseSourcePost('note' + serializeSourcePost(sp, false));
    ok('thumbUrl round-trips', parsed.sourcePost?.thumbUrl === sp.thumbUrl);
    ok('kind video round-trips', parsed.sourcePost?.kind === 'video');
    ok('no thumbUrl → key omitted', parseSourcePost('x' + serializeSourcePost({ ...sp, thumbUrl: undefined }, false)).sourcePost?.thumbUrl === undefined);
  }

  console.log('marker robustness:');
  {
    ok('no marker → passthrough content', parseSourcePost('plain text').content === 'plain text');
    ok('no marker → null source', parseSourcePost('plain text').sourcePost === null);
    ok('null source serializes to empty', serializeSourcePost(null, false) === '');
    // A caption containing the comment terminator and braces must not truncate the marker.
    const sp: SourcePost = { platform: 'x', label: 'X', url: 'https://x.com/1', title: 'a --> b } end', kind: 'link' };
    const stored = 'body' + serializeSourcePost(sp, false);
    ok('caption with --> and } round-trips', parseSourcePost(stored).sourcePost?.title === 'a --> b } end', parseSourcePost(stored).sourcePost?.title);
    ok('strip leaves clean body for tricky caption', stripSourceMarker(stored) === 'body');
    // Empty body + marker only → body becomes ''
    const only = serializeSourcePost(sp, false);
    ok('marker-only content strips to empty body', parseSourcePost(only).content === '');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
