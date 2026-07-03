/**
 * Unit tests for the share-intent normalizer. Framework-free:
 *   node src/share/normalizeShareIntent.test.ts
 * Exits non-zero on any failure. Side effects are stubbed via injected deps.
 */
import { normalizeShareIntent, IMAGE_INLINE_CAP, type ShareDeps } from './normalizeShareIntent.ts';

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, detail); }
}

let warns: string[] = [];
const deps: ShareDeps = {
  readBase64: async () => 'QkFTRTY0', // "BASE64"
  uploadFile: async (f) => ({ id: `att_${f.name}`, filename: f.name, mime_type: f.mimeType, size_bytes: f.size }),
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
    ok('no attachment for inline image', small.attachments.length === 0);
    ok('title = "Photo note"', small.title === 'Photo note');

    const big = await normalizeShareIntent(
      { files: [{ path: 'file:///b.png', mimeType: 'image/png', fileName: 'b.png', size: IMAGE_INLINE_CAP + 1 }] }, deps);
    ok('over-cap image → attachment, not inline', big.attachments.length === 1 && big.images.length === 0);
  }

  console.log('document / video files:');
  {
    const doc = await normalizeShareIntent(
      { files: [{ path: 'file:///r.pdf', mimeType: 'application/pdf', fileName: 'report.pdf', size: 2000 }] }, deps);
    ok('pdf → attachment', doc.attachments.length === 1 && doc.images.length === 0);
    ok('title from filename (no ext)', doc.title === 'report');
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
    ok('mixed: 1 image + 1 attachment', mixed.images.length === 1 && mixed.attachments.length === 1);
    ok('mixed title from first filename (not "Photo note")', mixed.title === 'p');
  }

  console.log('unknown type + empty:');
  {
    warns = [];
    const unk = await normalizeShareIntent(
      { files: [{ path: 'file:///x', mimeType: '', fileName: 'x', size: 10 }] }, deps);
    ok('unknown mime → attachment', unk.attachments.length === 1);
    ok('warned on unknown type', warns.length === 1);

    const empty = await normalizeShareIntent({}, deps);
    ok('empty intent → needsTitle', empty.needsTitle === true && empty.content === '' && empty.images.length === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
