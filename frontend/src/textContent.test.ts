/**
 * Unit tests for note-content → plain text. Framework-free:
 *   node --import ./src/crypto/_ts-resolver.mjs src/textContent.test.ts
 */
import { plainTextFromContent, decodeEntities } from './textContent.ts';
import { serializeSourcePost, type SourcePost } from './share/socialSource.ts';

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, detail); }
}

function main() {
  console.log('plainTextFromContent — rich HTML:');
  {
    ok('paragraph + bold/italic', plainTextFromContent('<p>Hello <strong>world</strong> and <em>more</em></p>') === 'Hello world and more');
    ok('bullet list → lines', plainTextFromContent('<ul><li>a</li><li>b</li></ul>') === 'a\nb');
    ok('<br> → newline', plainTextFromContent('line1<br>line2') === 'line1\nline2');
    ok('multi <p> → newlines', plainTextFromContent('<p>one</p><p>two</p>') === 'one\ntwo');
    ok('entities decoded', plainTextFromContent('<p>Caf&#233; &amp; tea &#128512;</p>') === 'Café & tea 😀', plainTextFromContent('<p>Caf&#233; &amp; tea &#128512;</p>'));
    ok('nbsp → space, collapsed', plainTextFromContent('<p>a&nbsp;&nbsp;b</p>') === 'a b');
  }

  console.log('plainTextFromContent — legacy plain text:');
  {
    ok('markdown markers stripped', plainTextFromContent('**bold** and *italic*') === 'bold and italic');
    ok('bullet chars stripped', plainTextFromContent('• item one\n• item two') === 'item one\nitem two');
    ok('dash list stripped', plainTextFromContent('- a\n- b') === 'a\nb');
    ok('plain stays plain', plainTextFromContent('just a note') === 'just a note');
  }

  console.log('plainTextFromContent — shared-post marker:');
  {
    const sp: SourcePost = { platform: 'youtube', label: 'YouTube', url: 'https://youtu.be/x', title: 'V', kind: 'video' };
    ok('marker stripped from HTML', plainTextFromContent('<p>my note</p>' + serializeSourcePost(sp, false)) === 'my note');
    ok('marker-only → empty', plainTextFromContent(serializeSourcePost(sp, false)) === '');
    ok('empty → empty', plainTextFromContent('') === '');
  }

  console.log('decodeEntities:');
  {
    ok('decimal', decodeEntities('caf&#233;') === 'café');
    ok('hex emoji', decodeEntities('&#x1F600;') === '😀');
    ok('amp last', decodeEntities('A &amp; B') === 'A & B');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
