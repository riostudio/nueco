/**
 * Unit tests for the event emoji map. Runnable without a framework:
 *   node --import ./src/crypto/_ts-resolver.mjs src/events/eventEmoji.test.ts
 *
 * The false-POSITIVE cases matter most here. A missing emoji costs nothing - the row renders as it
 * always has. A WRONG emoji is actively misleading on a list someone is scanning in a hurry, which
 * is the only reason this feature exists.
 */
import { emojiForEvent, prefixEmoji } from './eventEmoji.ts';

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name); }
}

console.log('event emoji');

// --- ordinary matches ---
const hits: Array<[string, string]> = [
  ['Dentist at 4:30', '🦷'],
  ['Call Mum tomorrow', '📞'],
  ['Flight to Sydney', '✈️'],
  ['Bergman invoice due', '🧾'],
  ['Standup', '👥'],
  ['Gym before work', '🏋️'],
  ['Coffee with Sam', '☕'],
  ['Mia birthday', '🎂'],
  ['Pay the rent', '💰'],
  ['rapat hari senin', '👥'],       // Indonesian: meeting on Monday
  ['makan malam', '🍽️'],            // Indonesian: dinner
];
for (const [title, emoji] of hits) ok(`"${title}" -> ${emoji}`, emojiForEvent(title) === emoji);

// --- phrases beat single words ---
ok('"birthday party" is a cake, not a popper', emojiForEvent('Sam birthday party') === '🎂');
ok('"site visit" beats bare "visit"', emojiForEvent('Site visit Thursday') === '🏗️');
ok('"drop off" is the school run', emojiForEvent('Drop off the kids') === '🚸');

// --- whole words only: the substring traps ---
ok('"grate" is not "rate"', emojiForEvent('Grate the cheese') === null);
ok('"scallop" does not match "call"', emojiForEvent('Scallop recipe') === null);
ok('"parties" does not match "party"', emojiForEvent('Parties research') === null);
ok('"services" does not match "service"', emojiForEvent('Services research') === null);

// --- punctuation and case must not hide a match ---
ok('punctuation is a separator', emojiForEvent('Dentist, 4:30pm') === '🦷');
ok('trailing bang still matches', emojiForEvent('Call Mum!') === '📞');
ok('uppercase matches', emojiForEvent('FLIGHT TO PERTH') === '✈️');
ok('digits do not break a match', emojiForEvent('Gym 6:15') === '🏋️');

// --- no generic fallback: silence is the correct answer ---
ok('unmatched title gets nothing', emojiForEvent('Thing about the stuff') === null);
ok('empty is null', emojiForEvent('') === null);
ok('whitespace is null', emojiForEvent('   ') === null);
ok('null input is null', emojiForEvent(null) === null);
ok('undefined input is null', emojiForEvent(undefined) === null);
ok('digits only is null', emojiForEvent('12345') === null);

// --- first match wins, deterministically ---
ok('same input twice gives the same answer',
  emojiForEvent('Dentist and coffee') === emojiForEvent('Dentist and coffee'));

// --- prefixEmoji: what the screens actually render ---
ok('prefix adds the emoji and a space', prefixEmoji('Dentist') === '🦷 Dentist');
ok('prefix leaves an unmatched title alone', prefixEmoji('Thing about stuff') === 'Thing about stuff');
ok('prefix of empty is empty', prefixEmoji('') === '');
ok('prefix of null is empty', prefixEmoji(null) === '');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
