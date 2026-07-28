/**
 * Unit tests for the display-side recurrence helper. Framework-free:
 *   node --import ./src/crypto/_ts-resolver.mjs src/recurrence.test.ts
 *
 * These deliberately test day-granularity behavior only (see recurrence.ts's
 * top-of-file comment) - this is not a test of exact reminder-firing instants,
 * that's covered server-side against `next_occurrence_on_or_after` in
 * backend/tests/test_memopad_apis.py.
 */
import { nextOccurrenceOnOrAfter, occursOnDay, formatRecurrenceSummary } from './recurrence.ts';
import type { CalendarEvent, Recurrence } from './types.ts';

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, detail); }
}

function mkEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'e1',
    title: 'Test event',
    description: '',
    location: '',
    start_time: '2026-07-13T09:00:00.000Z', // a Monday
    end_time: '2026-07-13T10:00:00.000Z',
    linked_note_ids: [],
    reminder_minutes: null,
    device_calendar_event_id: null,
    created_at: '2026-07-01T00:00:00.000Z',
    recurrence: null,
    timezone: 'UTC',
    trip_id: null,
    ...overrides,
  };
}

function ymd(iso: string): string {
  return iso.slice(0, 10);
}

function main() {
  console.log('nextOccurrenceOnOrAfter - no recurrence:');
  {
    const ev = mkEvent({ recurrence: null });
    ok('returns null', nextOccurrenceOnOrAfter(ev, new Date('2026-07-01T00:00:00.000Z')) === null);
  }

  console.log('nextOccurrenceOnOrAfter - daily:');
  {
    const recurrence: Recurrence = { freq: 'daily', byweekday: null, until: null };
    const ev = mkEvent({ start_time: '2026-07-13T09:00:00.000Z', recurrence });

    // from before start -> first occurrence is start itself
    const before = nextOccurrenceOnOrAfter(ev, new Date('2026-07-01T00:00:00.000Z'));
    ok('from before start -> returns start', before !== null && before.toISOString() === '2026-07-13T09:00:00.000Z', before?.toISOString());

    // from exactly on an occurrence -> returns that same instant
    const onOcc = nextOccurrenceOnOrAfter(ev, new Date('2026-07-15T09:00:00.000Z'));
    ok('from == an occurrence -> returns it', onOcc !== null && onOcc.toISOString() === '2026-07-15T09:00:00.000Z', onOcc?.toISOString());

    // from between two occurrences -> returns the next day's occurrence
    const between = nextOccurrenceOnOrAfter(ev, new Date('2026-07-15T12:00:00.000Z'));
    ok('from between occurrences -> next day', between !== null && ymd(between.toISOString()) === '2026-07-16', between?.toISOString());
  }

  console.log('nextOccurrenceOnOrAfter - weekly with byweekday:');
  {
    // Mon 2026-07-13 09:00 UTC, repeats Mon/Wed/Fri (1, 3, 5)
    const recurrence: Recurrence = { freq: 'weekly', byweekday: [1, 3, 5], until: null };
    const ev = mkEvent({ start_time: '2026-07-13T09:00:00.000Z', recurrence });

    // from is on the start's own weekday (Monday, matches) -> returns start
    const onStart = nextOccurrenceOnOrAfter(ev, new Date('2026-07-13T00:00:00.000Z'));
    ok('from before start weekday match -> returns start', onStart !== null && onStart.toISOString() === '2026-07-13T09:00:00.000Z', onStart?.toISOString());

    // from is after Monday but before Wednesday -> returns Wednesday
    const midWeek = nextOccurrenceOnOrAfter(ev, new Date('2026-07-14T00:00:00.000Z'));
    ok('from after Mon, before Wed -> returns Wed', midWeek !== null && ymd(midWeek.toISOString()) === '2026-07-15', midWeek?.toISOString());

    // from is after Friday -> returns following Monday
    const afterFri = nextOccurrenceOnOrAfter(ev, new Date('2026-07-18T00:00:00.000Z'));
    ok('from after Fri -> returns following Mon', afterFri !== null && ymd(afterFri.toISOString()) === '2026-07-20', afterFri?.toISOString());
  }

  console.log('nextOccurrenceOnOrAfter - weekly, start_time weekday not in byweekday:');
  {
    // start_time is Monday 2026-07-13, but only Wed/Fri (3, 5) are listed - start's own
    // weekday isn't in the set, so the first occurrence must still be found correctly
    // (Wednesday 2026-07-15), not the start date itself.
    const recurrence: Recurrence = { freq: 'weekly', byweekday: [3, 5], until: null };
    const ev = mkEvent({ start_time: '2026-07-13T09:00:00.000Z', recurrence });

    const first = nextOccurrenceOnOrAfter(ev, new Date('2026-07-01T00:00:00.000Z'));
    ok('first occurrence skips non-matching start weekday', first !== null && ymd(first.toISOString()) === '2026-07-15', first?.toISOString());
  }

  console.log('nextOccurrenceOnOrAfter - weekly, no byweekday (defaults to start weekday):');
  {
    const recurrence: Recurrence = { freq: 'weekly', byweekday: null, until: null };
    const ev = mkEvent({ start_time: '2026-07-13T09:00:00.000Z', recurrence }); // Monday

    const next = nextOccurrenceOnOrAfter(ev, new Date('2026-07-14T00:00:00.000Z'));
    ok('repeats only on start weekday (following Monday), not daily', next !== null && ymd(next.toISOString()) === '2026-07-20', next?.toISOString());
  }

  console.log('nextOccurrenceOnOrAfter - monthly:');
  {
    const recurrence: Recurrence = { freq: 'monthly', byweekday: null, until: null };
    const ev = mkEvent({ start_time: '2026-07-13T09:00:00.000Z', recurrence });

    const before = nextOccurrenceOnOrAfter(ev, new Date('2026-07-01T00:00:00.000Z'));
    ok('from before start -> returns start', before !== null && before.toISOString() === '2026-07-13T09:00:00.000Z', before?.toISOString());

    const between = nextOccurrenceOnOrAfter(ev, new Date('2026-07-14T00:00:00.000Z'));
    ok('from after start -> next month, same day-of-month', between !== null && ymd(between.toISOString()) === '2026-08-13', between?.toISOString());
  }

  console.log('nextOccurrenceOnOrAfter - yearly:');
  {
    const recurrence: Recurrence = { freq: 'yearly', byweekday: null, until: null };
    const ev = mkEvent({ start_time: '2026-07-13T09:00:00.000Z', recurrence });

    const onStart = nextOccurrenceOnOrAfter(ev, new Date('2026-07-13T00:00:00.000Z'));
    ok('from before start -> returns start', onStart !== null && onStart.toISOString() === '2026-07-13T09:00:00.000Z', onStart?.toISOString());

    const between = nextOccurrenceOnOrAfter(ev, new Date('2026-07-14T00:00:00.000Z'));
    ok('from after start -> next year, same month/day', between !== null && ymd(between.toISOString()) === '2027-07-13', between?.toISOString());
  }

  console.log('nextOccurrenceOnOrAfter - until boundary (inclusive):');
  {
    const recurrence: Recurrence = { freq: 'daily', byweekday: null, until: '2026-07-15' };
    const ev = mkEvent({ start_time: '2026-07-13T09:00:00.000Z', recurrence });

    const onUntil = nextOccurrenceOnOrAfter(ev, new Date('2026-07-15T00:00:00.000Z'));
    ok('until date itself is included', onUntil !== null && ymd(onUntil.toISOString()) === '2026-07-15', onUntil?.toISOString());

    const pastUntil = nextOccurrenceOnOrAfter(ev, new Date('2026-07-16T00:00:00.000Z'));
    ok('day after until -> null', pastUntil === null, pastUntil?.toISOString());
  }

  console.log('occursOnDay:');
  {
    const recurrence: Recurrence = { freq: 'weekly', byweekday: [1, 3, 5], until: null };
    const ev = mkEvent({ start_time: '2026-07-13T09:00:00.000Z', recurrence, timezone: 'UTC' });

    ok('matching weekday -> true', occursOnDay(ev, 2026, 6, 15)); // Wed 2026-07-15
    ok('non-matching weekday -> false', !occursOnDay(ev, 2026, 6, 16)); // Thu

    const nonRecurring = mkEvent({ recurrence: null });
    ok('non-recurring event -> false (no throw)', occursOnDay(nonRecurring, 2026, 6, 13) === false);
  }

  console.log('formatRecurrenceSummary:');
  {
    ok('null -> empty string', formatRecurrenceSummary(null) === '');

    ok('daily', formatRecurrenceSummary({ freq: 'daily', byweekday: null, until: null }) === 'Repeats daily');

    ok('weekly single day -> full name', formatRecurrenceSummary({ freq: 'weekly', byweekday: [1], until: null }) === 'Repeats every Monday',
      formatRecurrenceSummary({ freq: 'weekly', byweekday: [1], until: null }));

    ok('weekly multi day -> abbreviated, in weekday order', formatRecurrenceSummary({ freq: 'weekly', byweekday: [5, 1, 3], until: null }) === 'Repeats every Mon, Wed, Fri',
      formatRecurrenceSummary({ freq: 'weekly', byweekday: [5, 1, 3], until: null }));

    ok('weekly all 7 days -> daily', formatRecurrenceSummary({ freq: 'weekly', byweekday: [0, 1, 2, 3, 4, 5, 6], until: null }) === 'Repeats daily');

    ok('monthly', formatRecurrenceSummary({ freq: 'monthly', byweekday: null, until: null }) === 'Repeats monthly');

    ok('yearly', formatRecurrenceSummary({ freq: 'yearly', byweekday: null, until: null }) === 'Repeats yearly');

    ok('with until -> suffix appended', formatRecurrenceSummary({ freq: 'daily', byweekday: null, until: '2026-12-31' }) === 'Repeats daily until December 31, 2026',
      formatRecurrenceSummary({ freq: 'daily', byweekday: null, until: '2026-12-31' }));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
