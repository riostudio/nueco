/**
 * Unit tests for the share-intent normalizer. Framework-free:
 *   node src/share/normalizeShareIntent.test.ts
 * Exits non-zero on any failure. Side effects are stubbed via injected deps.
 */
import { normalizeShareIntent, IMAGE_INLINE_CAP, IMAGE_INLINE_TOTAL_BUDGET, type ShareDeps } from './normalizeShareIntent.ts';

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, detail); }
}

let warns: string[] = [];
const deps: ShareDeps = {
  readBase64: async () => 'QkFTRTY0', // "BASE64"
  onWarn: (m) => warns.push(m),
};

async function main() {
  console.log('URL shares:');
  {
    const d = await normalizeShareIntent({ webUrl: 'https://ex.com/x', meta: { title: 'Ex Page' } }, deps);
    ok('title = page title', d.title === 'Ex Page');
    ok('content = url', d.content === 'https://ex.com/x');
    ok('tagged "link"', d.tags.length === 1 && d.tags[0].name === 'link');
    ok('no needsTitle (has title)', d.needsTitle === false);

    const d2 = await normalizeShareIntent({ webUrl: 'https://ex.com/y' }, deps);
    ok('no meta title → title = url', d2.title === 'https://ex.com/y');

    const d3 = await normalizeShareIntent({ text: 'https://ex.com/z' }, deps);
    ok('bare-url text treated as link', d3.tags[0]?.name === 'link' && d3.content === 'https://ex.com/z');
  }

  console.log('plain text:');
  {
    const d = await normalizeShareIntent({ text: 'forwarded message body' }, deps);
    ok('content = text', d.content === 'forwarded message body');
    ok('no title, needsTitle=true', d.title === '' && d.needsTitle === true);
    ok('no tags', d.tags.length === 0);
  }

  console.log('image files:');
  {
    const small = await normalizeShareIntent(
      { files: [{ path: 'file:///a.jpg', mimeType: 'image/jpeg', fileName: 'a.jpg', size: 1000 }] }, deps);
    ok('small image inlined as data URI', small.images.length === 1 && small.images[0].startsWith('data:image/jpeg;base64,'));
    ok('no pending file for inline image', small.pendingFiles.length === 0);
    ok('title = "Photo note"', small.title === 'Photo note');

    const big = await normalizeShareIntent(
      { files: [{ path: 'file:///b.png', mimeType: 'image/png', fileName: 'b.png', size: IMAGE_INLINE_CAP + 1 }] }, deps);
    ok('over-cap image → pending file, not inline', big.pendingFiles.length === 1 && big.images.length === 0);
  }

  console.log('document / audio / video files → pending upload:');
  {
    const doc = await normalizeShareIntent(
      { files: [{ path: 'file:///r.pdf', mimeType: 'application/pdf', fileName: 'report.pdf', size: 2000 }] }, deps);
    ok('pdf → pending file', doc.pendingFiles.length === 1 && doc.images.length === 0);
    ok('pending file carries uri/name/mime/size', doc.pendingFiles[0].uri === 'file:///r.pdf' && doc.pendingFiles[0].name === 'report.pdf' && doc.pendingFiles[0].size === 2000);
    ok('title from filename (no ext)', doc.title === 'report');

    const audio = await normalizeShareIntent(
      { files: [{ path: 'file:///s.m4a', mimeType: 'audio/mp4', fileName: 's.m4a', size: 9000 }] }, deps);
    ok('audio → pending file', audio.pendingFiles.length === 1);
  }

  console.log('multiple files → one draft:');
  {
    const multi = await normalizeShareIntent({ files: [
      { path: 'file:///1.jpg', mimeType: 'image/jpeg', fileName: '1.jpg', size: 500 },
      { path: 'file:///2.jpg', mimeType: 'image/jpeg', fileName: '2.jpg', size: 500 },
      { path: 'file:///3.jpg', mimeType: 'image/jpeg', fileName: '3.jpg', size: 500 },
    ] }, deps);
    ok('3 images in one draft', multi.images.length === 3);

    const mixed = await normalizeShareIntent({ files: [
      { path: 'file:///p.jpg', mimeType: 'image/jpeg', fileName: 'p.jpg', size: 500 },
      { path: 'file:///d.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fileName: 'd.docx', size: 5000 },
    ] }, deps);
    ok('mixed: 1 inline image + 1 pending file', mixed.images.length === 1 && mixed.pendingFiles.length === 1);
    ok('mixed title from first filename (not "Photo note")', mixed.title === 'p');
  }

  console.log('unknown type + empty:');
  {
    warns = [];
    const unk = await normalizeShareIntent(
      { files: [{ path: 'file:///x', mimeType: '', fileName: 'x', size: 10 }] }, deps);
    ok('unknown mime → pending file', unk.pendingFiles.length === 1);
    ok('unknown mime defaults to octet-stream', unk.pendingFiles[0].mimeType === 'application/octet-stream');
    ok('warned on unknown type', warns.length === 1);

    const empty = await normalizeShareIntent({}, deps);
    ok('empty intent → needsTitle', empty.needsTitle === true && empty.content === '' && empty.images.length === 0);
  }

  console.log('multi-image cumulative budget:');
  {
    const twoMB = 2 * 1024 * 1024; // 3 × 2MB = 6MB > 5MB budget
    const d = await normalizeShareIntent({ files: [
      { path: 'file:///1.jpg', mimeType: 'image/jpeg', fileName: '1.jpg', size: twoMB },
      { path: 'file:///2.jpg', mimeType: 'image/jpeg', fileName: '2.jpg', size: twoMB },
      { path: 'file:///3.jpg', mimeType: 'image/jpeg', fileName: '3.jpg', size: twoMB },
    ] }, deps);
    ok('first images inlined up to budget', d.images.length === 2, `got ${d.images.length}`);
    ok('over-budget image overflows to pending file', d.pendingFiles.length === 1);
    ok('budget constant sane', IMAGE_INLINE_TOTAL_BUDGET <= 8 * 1024 * 1024);
  }

  console.log('filename sanitization:');
  {
    const d = await normalizeShareIntent(
      { files: [{ path: 'file:///x', mimeType: 'application/pdf', fileName: '../../etc/evil.pdf', size: 100 }] }, deps);
    ok('path separators stripped from pending filename', !/[/\\]/.test(d.pendingFiles[0].name), d.pendingFiles[0]?.name);
  }

  console.log('inline-read failure falls back to pending upload:');
  {
    const failRead: ShareDeps = { ...deps, readBase64: async () => { throw new Error('read failed'); } };
    const d = await normalizeShareIntent(
      { files: [{ path: 'file:///a.jpg', mimeType: 'image/jpeg', fileName: 'a.jpg', size: 1000 }] }, failRead);
    ok('unreadable inline image → pending file (not lost)', d.pendingFiles.length === 1 && d.images.length === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
