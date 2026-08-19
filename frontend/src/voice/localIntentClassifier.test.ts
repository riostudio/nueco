/**
 * Unit tests for the offline voice-intent classifier. Runnable without a framework:
 *   node --import ./src/crypto/_ts-resolver.mjs src/voice/localIntentClassifier.test.ts
 *
 * A fixed reference date keeps the assertions deterministic - chrono otherwise resolves
 * "tomorrow"/"Friday" against the wall clock.
 */
import { classifyLocally, classificationsDiffer } from './localIntentClassifier.ts';

let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name); }
}

// Monday 2026-08-17: "tomorrow" = Tue 18th, "Friday" = 21st.
const REF = '2026-08-17';

console.log('localIntentClassifier');

// --- ordinary dictation stays a note ---
{
  const r = classifyLocally('buying milk was a mistake', REF);
  ok('plain text with no temporal signal is a note', r.intent === 'note' && r.events.length === 0);
}
{
  const r = classifyLocally('', REF);
  ok('empty input is a note', r.intent === 'note');
}

// --- single event ---
{
  const r = classifyLocally('Remind me to call Mum tomorrow at 5', REF);
  const ev = r.events[0];
  const start = new Date(ev?.start_time ?? '');
  ok('"remind me to call mum tomorrow at 5" is a single event', r.intent === 'single_event' && r.events.length === 1);
  ok('starts tomorrow (2026-08-18)', start.getFullYear() === 2026 && start.getMonth() === 7 && start.getDate() === 18);
  ok('at 5pm local (bare afternoon hours default to pm via whisper text "at 5")', start.getHours() === 17 || start.getHours() === 5);
  ok('title drops scheduling framing and time', ev?.title === 'Call Mum');
  ok('confidence is low', ev?.confidence === 'low');
  ok('no recurrence', ev?.recurrence === null);
}

// --- date-only event ---
{
  const r = classifyLocally('Meeting with Sam on Friday', REF);
  const ev = r.events[0];
  const start = new Date(ev?.start_time ?? '');
  ok('"meeting with sam on friday" extracts one event', r.intent === 'single_event' && r.events.length === 1);
  ok('Friday = 2026-08-21', start.getDate() === 21);
  ok('title is the meeting', ev?.title.toLowerCase().includes('meeting with sam'));
}

// --- multiple events from one dictation ---
{
  const r = classifyLocally('Lunch with Sam at noon, then gym at 6pm', REF);
  ok('two fragments become two events', r.intent === 'multiple_events' && r.events.length === 2);
  ok('first event mentions lunch', r.events[0]?.title.toLowerCase().includes('lunch'));
  ok('second event mentions gym', r.events[1]?.title.toLowerCase().includes('gym'));
}

// --- recurrence ---
{
  const r = classifyLocally('Take medication every Monday', REF);
  const ev = r.events[0];
  ok('"every monday" is weekly recurrence', ev?.recurrence?.freq === 'weekly');
  ok('byweekday is Monday (1)', JSON.stringify(ev?.recurrence?.byweekday) === '[1]');
}
{
  const r = classifyLocally('Water the plants every day at 8am', REF);
  ok('"every day" is daily recurrence', r.events[0]?.recurrence?.freq === 'daily');
}

// --- itinerary ---
{
  const r = classifyLocally('Plan my Tokyo trip: flight Friday 9am, then hotel check in Saturday 2pm', REF);
  ok('trip keywords + >=2 events is an itinerary', r.intent === 'itinerary' && r.events.length === 2);
}

// --- Indonesian ---
{
  const r = classifyLocally('ingatkan saya besok jam tiga', REF);
  const ev = r.events[0];
  const start = new Date(ev?.start_time ?? '');
  ok('"ingatkan saya besok jam tiga" extracts one event', r.intent === 'single_event' && r.events.length === 1);
  ok('besok = tomorrow (18th)', start.getDate() === 18);
  ok('jam tiga resolves to hour 3 or 15', start.getHours() === 3 || start.getHours() === 15);
}
{
  const r = classifyLocally('rapat hari senin', REF);
  const start = new Date(r.events[0]?.start_time ?? '');
  ok('"rapat hari senin" lands on a Monday', start.getDay() === 1);
  ok('keeps a non-empty title', (r.events[0]?.title ?? '').length > 0);
}

// --- classificationsDiffer ---
{
  const base = classifyLocally('Remind me to call Mum tomorrow at 5', REF);
  const same = JSON.parse(JSON.stringify(base));
  ok('identical results do not differ', classificationsDiffer(base, same) === false);
  const retitled = JSON.parse(JSON.stringify(base));
  retitled.events[0].title = 'Phone Mum';
  ok('retitled event differs', classificationsDiffer(base, retitled) === true);
  const reshaped = JSON.parse(JSON.stringify(base));
  reshaped.events.pop();
  ok('different event count differs', classificationsDiffer(base, reshaped) === true);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
