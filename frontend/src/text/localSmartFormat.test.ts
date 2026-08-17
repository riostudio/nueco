/**
 * Unit tests for the on-device smart_format fallback. Framework-free:
 *   node --import ./src/crypto/_ts-resolver.mjs src/text/localSmartFormat.test.ts
 */
import { formatTextLocally } from './localSmartFormat.ts';

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, detail); }
}

function main() {
  console.log('formatTextLocally - checklist-shaped captures format locally:');
  {
    const html = formatTextLocally('create me a checklist: buy milk, walk the dog, call mom');
    ok('returns taskList markup', !!html && html.startsWith('<ul data-type="taskList">'), String(html));
    ok('every item present', !!html && html.includes('buy milk') && html.includes('walk the dog') && html.includes('call mom'));
    ok('items start unchecked', !!html && html.includes('data-checked="false"'));
  }
  {
    const html = formatTextLocally('start a shopping list: milk, eggs');
    ok('shopping-list command formats too', !!html && html.includes('milk') && html.includes('eggs'));
  }

  console.log('formatTextLocally - non-checklist text stays null (raw kept):');
  {
    ok('plain dictation -> null', formatTextLocally('Meeting with Sam on Friday at noon to discuss the budget') === null);
    ok('mid-sentence checklist mention -> null', formatTextLocally('I forgot the checklist on the kitchen counter') === null);
    ok('empty string -> null', formatTextLocally('') === null);
  }
  {
    ok('checklist command with no items -> null', formatTextLocally('create me a checklist') === null);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
