/**
 * Unit tests for the display-side recurrence helper. Framework-free:
 *   node --import ./src/crypto/_ts-resolver.mjs src/recurrence.test.ts
 *
 * These deliberately test day-granularity behavior only (see recurrence.ts's
 * top-of-file comment) - this is not a test of exact reminder-firing instants,
 * that's covered server-side against `next_occurrence_on_or_after` in
 * backend/tests/test_nueco_apis.py.
 */
import { nextOccurrenceOnOrAfter, occursOnDay, eventCoversDay, formatRecurrenceSummary } from './recurrence.ts';
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

  // Both blocks below run under TZ=Australia/Melbourne - a positive UTC offset, matching the
  // original bug report (a device all-day event's UTC-midnight start rendered as a spurious
  // 10am/11am local clock time). eventCoversDay's all-day branch never converts through an
  // instant at all, so these must land on the exact stored date regardless of device timezone.
  const prevTz = process.env.TZ;
  process.env.TZ = 'Australia/Melbourne';
  try {
    console.log('eventCoversDay - all-day event from a positive-UTC-offset timezone:');
    {
      // Single-day all-day event: end_time is the day *after* start_time (iCal convention -
      // see calendarSyncCore.ts), so it covers exactly one calendar day.
      const holiday = mkEvent({
        all_day: true,
        start_time: '2026-09-28',
        end_time: '2026-09-29',
        recurrence: null,
      });
      ok('covers its own date (28 Sep)', eventCoversDay(holiday, 2026, 8, 28) === true);
      ok('does not cover the day before (27 Sep)', eventCoversDay(holiday, 2026, 8, 27) === false);
      ok('does not cover the day after (29 Sep, exclusive end)', eventCoversDay(holiday, 2026, 8, 29) === false);
    }

    console.log('eventCoversDay - all-day events either side of a DST transition:');
    {
      // Melbourne's AEDT (UTC+11) starts 4 Oct 2026.
      const beforeDst = mkEvent({
        all_day: true,
        start_time: '2026-09-28',
        end_time: '2026-09-29',
        recurrence: null,
      });
      const afterDst = mkEvent({
        all_day: true,
        start_time: '2026-10-05',
        end_time: '2026-10-06',
        recurrence: null,
      });
      ok('pre-DST event still lands on 28 Sep, not shifted by the upcoming transition',
        eventCoversDay(beforeDst, 2026, 8, 28) === true);
      ok('post-DST event still lands on 5 Oct, not shifted by the just-passed transition',
        eventCoversDay(afterDst, 2026, 9, 5) === true);
      ok('post-DST event does not leak onto 4 Oct (the transition day itself)',
        eventCoversDay(afterDst, 2026, 9, 4) === false);
    }
  } finally {
    if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
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
