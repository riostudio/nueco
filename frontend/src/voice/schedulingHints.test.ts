/**
 * Unit tests for the local scheduling detector. Runnable without a framework:
 *   node --import ./src/crypto/_ts-resolver.mjs src/voice/schedulingHints.test.ts
 *
 * The false-NEGATIVE cases matter far more than the false-positive ones: a missed scheduling
 * phrase silently loses event extraction the user asked for, whereas an unnecessary "yes" only
 * costs the round-trip we were making anyway.
 */
import { looksLikeScheduling } from './schedulingHints.ts';

let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name); }
}

console.log('scheduling hints');

// --- must be YES (missing these silently breaks event extraction) ---
const scheduling = [
  'Remind me to call Mum tomorrow at 5',
  'Dentist appointment at 4:30',
  'Meeting with Sam on Tuesday',
  'Take medication every Monday',
  'Plan my Tokyo trip: flight Friday 9am',
  'Pay the invoice by 12/03',
  'Standup at 9',
  'Book the venue next week',
  'Coffee tonight',
  'Deadline is March 3',
  'ingatkan saya besok jam tiga',      // Indonesian: remind me tomorrow at three
  'rapat hari senin',                   // Indonesian: meeting on Monday
];
for (const t of scheduling) ok(`YES: "${t}"`, looksLikeScheduling(t) === true);

// --- should be NO (these are the ones that save a round-trip) ---
const notScheduling = [
  'Things I want to remember about today',           // "today" IS present -> expected YES, see below
];
void notScheduling;

const plainNotes = [
  'Coffee with Sam at the place near the bridge',     // has "at" + no digits... but no time word
  'Ideas for the new landing page',
  'The blue jacket in the window, go back for it',
  'Ask Dad about the recipe',
  'Groceries: milk, eggs, bread',
  'Remember to breathe',
  'Book review notes on the novel I finished',
];
for (const t of plainNotes) ok(`NO: "${t}"`, looksLikeScheduling(t) === false);

// --- safe-direction guarantees ---
ok('empty input defers to the classifier', looksLikeScheduling('') === true);
ok('whitespace defers to the classifier', looksLikeScheduling('   ') === true);
ok('punctuation does not hide a keyword', looksLikeScheduling('Call her Tuesday.') === true);
ok('capitalisation is ignored', looksLikeScheduling('MEETING FRIDAY') === true);
ok("o'clock survives apostrophe splitting", looksLikeScheduling("see you at three o'clock") === true);
ok('bare time with no keyword still matches', looksLikeScheduling('gym 6:15') === true);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
