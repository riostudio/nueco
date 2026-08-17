/**
 * Unit tests for the smart_format HTML preview parser. Framework-free:
 *   node --import ./src/crypto/_ts-resolver.mjs src/structuredHtmlPreview.test.ts
 */
import { parseStructuredHtml, stripInlineTags, decodeEntities } from './structuredHtmlPreview.ts';

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, detail); }
}

console.log('parseStructuredHtml');

{
  const blocks = parseStructuredHtml(
    '<p>Toast</p><h3>Ingredients</h3><ul><li>2 slices bread</li><li>butter</li></ul><h3>Steps</h3><ol><li>Toast it</li><li>Eat</li></ol>',
  );
  ok('recipe shape: 7 blocks', blocks.length === 7, JSON.stringify(blocks));
  ok('first block is the paragraph', blocks[0].kind === 'paragraph' && blocks[0].text === 'Toast');
  ok('heading preserved', blocks[1].kind === 'heading' && blocks[1].text === 'Ingredients');
  ok('bullets preserved with detail', blocks[2].kind === 'bullet' && blocks[2].text === '2 slices bread');
  ok('numbered steps in order', blocks[5].kind === 'numbered' && blocks[5].text === 'Toast it' && blocks[6].text === 'Eat');
}

{
  const blocks = parseStructuredHtml('<ul><li>☐ call mum</li><li>☐ <strong>buy milk</strong></li></ul>');
  ok('checklist keeps the ☐ marker', blocks[0].kind === 'bullet' && blocks[0].text === '☐ call mum');
  ok('inline tags stripped to text', blocks[1].text === '☐ buy milk');
}

{
  const blocks = parseStructuredHtml('just plain words, no tags at all');
  ok('tagless input degrades to one paragraph', blocks.length === 1 && blocks[0].kind === 'paragraph' && blocks[0].text === 'just plain words, no tags at all');
}

{
  const blocks = parseStructuredHtml('<ul><li>orphan without closing tag</ul>');
  ok('malformed list still yields the item', blocks.length === 1 && blocks[0].text === 'orphan without closing tag');
}

{
  ok('empty input yields nothing', parseStructuredHtml('').length === 0);
  ok('whitespace-only yields nothing', parseStructuredHtml('   ').length === 0);
  ok('empty list yields nothing', parseStructuredHtml('<ul></ul>').length === 0);
}

console.log('stripInlineTags / decodeEntities');
{
  ok('br becomes newline then collapses', stripInlineTags('line one<br>line two') === 'line one\nline two');
  ok('entities decoded', decodeEntities('fish &amp; chips &lt;3') === 'fish & chips <3');
  ok('numeric entity decoded', decodeEntities('&#8217;') === '\u2019');
  ok('unknown entity left alone', decodeEntities('&weird;') === '&weird;');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
