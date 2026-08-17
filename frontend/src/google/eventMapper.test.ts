/**
 * Unit tests for the Google Calendar event mapper. Framework-free:
 *   node --import ./src/crypto/_ts-resolver.mjs src/google/eventMapper.test.ts
 */
import {
  recurrenceToRRule,
  rruleToRecurrence,
  nuecoEventToGoogle,
  googleEventToNueco,
  mapAttendees,
  type GoogleEventResource,
} from './eventMapper.ts';
import type { CalendarEvent } from '../types.ts';

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, detail); }
}

function mkEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'e1',
    title: 'Team standup',
    description: 'Weekly sync',
    location: 'Room 1',
    start_time: '2026-08-12T09:00:00+10:00',
    end_time: '2026-08-12T09:30:00+10:00',
    linked_note_ids: [],
    reminder_minutes: null,
    device_calendar_event_id: null,
    created_at: '2026-08-01T00:00:00.000Z',
    recurrence: null,
    timezone: null,
    trip_id: null,
    ...overrides,
  };
}

function main() {
  console.log('recurrenceToRRule');
  {
    ok('daily', recurrenceToRRule({ freq: 'daily', byweekday: null, until: null }, false) === 'FREQ=DAILY');
    ok('weekly with weekdays (0=Sun,2=Tue)',
      recurrenceToRRule({ freq: 'weekly', byweekday: [0, 2], until: null }, false) === 'FREQ=WEEKLY;BYDAY=SU,TU');
    ok('monthly', recurrenceToRRule({ freq: 'monthly', byweekday: null, until: null }, false) === 'FREQ=MONTHLY');
    ok('yearly', recurrenceToRRule({ freq: 'yearly', byweekday: null, until: null }, false) === 'FREQ=YEARLY');
    ok('null recurrence → null', recurrenceToRRule(null, false) === null);
    ok('until (timed) → end-of-day UTC',
      recurrenceToRRule({ freq: 'daily', byweekday: null, until: '2026-12-31' }, false) === 'FREQ=DAILY;UNTIL=20261231T235959Z');
    ok('until (all-day) → bare date',
      recurrenceToRRule({ freq: 'daily', byweekday: null, until: '2026-12-31' }, true) === 'FREQ=DAILY;UNTIL=20261231');
  }

  console.log('rruleToRecurrence');
  {
    ok('FREQ=DAILY', rruleToRecurrence(['RRULE:FREQ=DAILY'], undefined).recurrence?.freq === 'daily');
    const weekly = rruleToRecurrence(['RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR'], undefined);
    ok('weekly BYDAY maps to weekday indices', JSON.stringify(weekly.recurrence?.byweekday) === '[1,3,5]');
    const until = rruleToRecurrence(['RRULE:FREQ=MONTHLY;UNTIL=20261001T235959Z'], undefined);
    ok('UNTIL datetime → ISO date', until.recurrence?.until === '2026-10-01');
    const untilDate = rruleToRecurrence(['RRULE:FREQ=YEARLY;UNTIL=20270101'], undefined);
    ok('UNTIL bare date → ISO date', untilDate.recurrence?.until === '2027-01-01');

    ok('COUNT degrades', rruleToRecurrence(['RRULE:FREQ=DAILY;COUNT=5'], undefined).recurrence === null);
    ok('INTERVAL degrades', rruleToRecurrence(['RRULE:FREQ=WEEKLY;INTERVAL=2'], undefined).recurrence === null);
    ok('HOURLY degrades', rruleToRecurrence(['RRULE:FREQ=HOURLY'], undefined).recurrence === null);
    ok('EXDATE degrades', rruleToRecurrence(['RRULE:FREQ=DAILY', 'EXDATE:20260815T090000Z'], undefined).recurrence === null);
    ok('BYMONTHDAY degrades', rruleToRecurrence(['RRULE:FREQ=MONTHLY;BYMONTHDAY=15'], undefined).recurrence === null);
    const degraded = rruleToRecurrence(['RRULE:FREQ=DAILY;COUNT=3'], undefined);
    ok('degradation carries a reason', !!degraded.unsupported && degraded.unsupported.includes('COUNT'));
  }

  console.log('nuecoEventToGoogle');
  {
    const g = nuecoEventToGoogle(mkEvent({ reminder_minutes: 15, recurrence: { freq: 'weekly', byweekday: [1], until: null }, timezone: 'Australia/Sydney' }), 'UTC');
    ok('summary/description/location', g.summary === 'Team standup' && g.description === 'Weekly sync' && g.location === 'Room 1');
    ok('timed start carries dateTime + timeZone', g.start?.dateTime === '2026-08-12T09:00:00+10:00' && g.start?.timeZone === 'Australia/Sydney');
    ok('recurrence → RRULE', g.recurrence?.[0] === 'FREQ=WEEKLY;BYDAY=MO');
    ok('reminder → popup override', g.reminders?.useDefault === false && g.reminders?.overrides?.[0]?.minutes === 15);

    const noReminder = nuecoEventToGoogle(mkEvent(), 'UTC');
    ok('no reminder → useDefault', noReminder.reminders?.useDefault === true);
    ok('fallback to calendar timezone', nuecoEventToGoogle(mkEvent(), 'Pacific/Auckland').start?.timeZone === 'Pacific/Auckland');

    const allDay = nuecoEventToGoogle(mkEvent({ all_day: true, start_time: '2026-09-28', end_time: '2026-09-29' }), 'UTC');
    ok('all-day uses date-only (exclusive end)', allDay.start?.date === '2026-09-28' && allDay.end?.date === '2026-09-29' && !allDay.start?.dateTime);
  }

  console.log('googleEventToNueco');
  {
    const timed: GoogleEventResource = {
      id: 'g1',
      summary: 'Dentist',
      description: '',
      location: 'Clinic',
      start: { dateTime: '2026-08-20T14:00:00+10:00', timeZone: 'Australia/Sydney' },
      end: { dateTime: '2026-08-20T15:00:00+10:00', timeZone: 'Australia/Sydney' },
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH'],
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] },
      attendees: [{ email: 'a@example.com', responseStatus: 'accepted', self: true }],
      updated: '2026-08-10T00:00:00.000Z',
    };
    const mapped = googleEventToNueco(timed);
    ok('timed fields', mapped.event.start_time === '2026-08-20T14:00:00+10:00' && mapped.event.all_day === false);
    ok('timezone mirrored', mapped.event.timezone === 'Australia/Sydney');
    ok('weekly Thursday recurrence', mapped.event.recurrence?.freq === 'weekly' && JSON.stringify(mapped.event.recurrence?.byweekday) === '[4]');
    ok('reminder snaps 10 → 15', mapped.event.reminder_minutes === 15);
    ok('attendees mirrored', mapped.event.attendees?.[0]?.email === 'a@example.com' && mapped.event.attendees?.[0]?.self === true);
    ok('google updated stored', mapped.event.google_event_updated === '2026-08-10T00:00:00.000Z');
    ok('no degradation note', mapped.degraded === null);

    const allDayG: GoogleEventResource = {
      id: 'g2',
      summary: 'Holiday',
      start: { date: '2026-09-28' },
      end: { date: '2026-09-29' },
    };
    const mappedAllDay = googleEventToNueco(allDayG);
    ok('all-day fields', mappedAllDay.event.all_day === true && mappedAllDay.event.start_time === '2026-09-28' && mappedAllDay.event.end_time === '2026-09-29');

    const exotic: GoogleEventResource = {
      id: 'g3',
      summary: 'Payroll',
      description: 'Existing note',
      start: { dateTime: '2026-09-01T09:00:00Z' },
      end: { dateTime: '2026-09-01T10:00:00Z' },
      recurrence: ['RRULE:FREQ=MONTHLY;BYMONTHDAY=-1'],
    };
    const mappedExotic = googleEventToNueco(exotic);
    ok('unsupported RRULE → single occurrence', mappedExotic.event.recurrence === null);
    ok('degradation note appended (original text kept)',
      !!mappedExotic.event.description && mappedExotic.event.description.startsWith('Existing note') && mappedExotic.event.description.includes('BYMONTHDAY'));
    ok('untitled → placeholder', googleEventToNueco({ id: 'g4', start: { date: '2026-01-01' }, end: { date: '2026-01-02' } }).event.title === '(No title)');
  }

  console.log('mapAttendees');
  {
    ok('empty → null', mapAttendees([]) === null && mapAttendees(undefined) === null);
    ok('drops attendees without email', mapAttendees([{ displayName: 'No email' }]) === null);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
