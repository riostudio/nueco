/**
 * Unit tests for the spoken-checklist recognizer. Framework-free:
 *   node --import ./src/crypto/_ts-resolver.mjs src/checklistFromSpeech.test.ts
 */
import { parseChecklistFromSpeech, buildChecklistHtml } from './checklistFromSpeech.ts';

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, detail); }
}

function main() {
  console.log('parseChecklistFromSpeech - recognizes checklist requests:');
  {
    const r = parseChecklistFromSpeech('create me a checklist: buy milk, walk the dog, call mom');
    ok('isChecklist true', r.isChecklist === true);
    ok('items split on commas', r.items.join('|') === 'buy milk|walk the dog|call mom', r.items.join('|'));
  }
  {
    const r = parseChecklistFromSpeech('create me a to do list buy milk and walk the dog and call mom');
    ok('to do list (no hyphen) recognized', r.isChecklist === true);
    ok('items split on " and "', r.items.join('|') === 'buy milk|walk the dog|call mom', r.items.join('|'));
  }
  {
    const r = parseChecklistFromSpeech('Make a to-do list for groceries: eggs, bread, cheese');
    ok('to-do list with hyphen + "for" filler recognized', r.isChecklist === true);
    ok('items after "for X:" filler', r.items.join('|') === 'eggs|bread|cheese', r.items.join('|'));
  }
  {
    const r = parseChecklistFromSpeech('start a shopping list with apples, bananas');
    ok('shopping list recognized', r.isChecklist === true);
    ok('items', r.items.join('|') === 'apples|bananas');
  }
  {
    const r = parseChecklistFromSpeech('please can you make me a checklist: pack passport, book taxi');
    ok('leading politeness filler stripped', r.isChecklist === true);
    ok('items', r.items.join('|') === 'pack passport|book taxi');
  }
  {
    const r = parseChecklistFromSpeech('build a task list - review PR, deploy backend');
    ok('task list with dash separator', r.isChecklist === true);
    ok('items', r.items.join('|') === 'review PR|deploy backend');
  }

  console.log('parseChecklistFromSpeech - numbered/bulleted item cleanup:');
  {
    const r = parseChecklistFromSpeech('create a checklist: 1. buy milk, 2. walk the dog');
    ok('leading numbering stripped from items', r.items.join('|') === 'buy milk|walk the dog', r.items.join('|'));
  }

  console.log('parseChecklistFromSpeech - empty item list:');
  {
    const r = parseChecklistFromSpeech('create me a checklist');
    ok('still recognized with no items said', r.isChecklist === true);
    ok('falls back to one empty item', r.items.length === 1 && r.items[0] === '');
  }

  console.log('parseChecklistFromSpeech - does not misfire on ordinary dictation:');
  {
    const r = parseChecklistFromSpeech('I need to remember to check my checklist later today');
    ok('mid-sentence mention of "checklist" is not a trigger', r.isChecklist === false);
  }
  {
    const r = parseChecklistFromSpeech('Meeting notes: discussed the roadmap and budget for next quarter');
    ok('unrelated dictation not recognized', r.isChecklist === false);
  }
  {
    const r = parseChecklistFromSpeech('');
    ok('empty transcript not recognized', r.isChecklist === false);
  }

  console.log('buildChecklistHtml:');
  {
    const html = buildChecklistHtml(['buy milk', 'walk the dog']);
    ok('wraps in taskList ul', html.startsWith('<ul data-type="taskList">') && html.endsWith('</ul>'));
    ok('each item is an unchecked taskItem li', (html.match(/data-type="taskItem" data-checked="false"/g) || []).length === 2);
    ok('checkbox input present per item', (html.match(/<input type="checkbox">/g) || []).length === 2);
    ok('item text present', html.includes('<p>buy milk</p>') && html.includes('<p>walk the dog</p>'));
  }
  {
    const html = buildChecklistHtml(['a < b & "c"']);
    ok('item text is HTML-escaped', html.includes('<p>a &lt; b &amp; "c"</p>'), html);
    ok('no raw angle brackets from item content leak into the tag structure', !html.includes('< b'));
  }
  {
    const html = buildChecklistHtml([]);
    ok('empty items -> empty taskList (no li)', html === '<ul data-type="taskList"></ul>');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
