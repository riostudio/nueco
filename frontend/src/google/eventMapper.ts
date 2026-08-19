/**
 * google/eventMapper.ts
 * Pure mapping between Nueco CalendarEvents and Google Calendar API v3 event resources.
 * Pure logic - no react/react-native/expo imports (clean-architecture rule).
 *
 * Guiding rule: NEVER fabricate data. Anything Google expresses that Nueco's model can't
 * (exotic RRULE parts, COUNT, INTERVAL≠1, EXDATE...) degrades to the single next occurrence
 * plus a human-readable note appended to the description, so the user sees the truth instead of
 * a silently-wrong recurrence.
 */
import type { CalendarEvent, Recurrence, GoogleAttendee, ReminderMinutes } from '../types';

// Nueco only offers fixed reminder offsets; snap an imported Google value to the closest one.
const ALLOWED_REMINDERS: ReminderMinutes[] = [5, 15, 30, 60, 1440];
function snapReminder(minutes: number): ReminderMinutes {
  let best: ReminderMinutes = ALLOWED_REMINDERS[0];
  for (const m of ALLOWED_REMINDERS) {
    // <= so an exact tie (e.g. 10 between 5 and 15) snaps up to the earlier warning.
    if (Math.abs(m - minutes) <= Math.abs(best - minutes)) best = m;
  }
  return best;
}

// ---------- Types for the Google side (subset we use) ----------

export interface GoogleEventTime {
  date?: string; // all-day: YYYY-MM-DD
  dateTime?: string; // timed: full ISO-8601 with offset
  timeZone?: string; // IANA
}

export interface GoogleEventResource {
  id?: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleEventTime;
  end?: GoogleEventTime;
  recurrence?: string[];
  attendees?: {
    email?: string;
    displayName?: string;
    responseStatus?: string;
    organizer?: boolean;
    self?: boolean;
  }[];
  reminders?: {
    useDefault: boolean;
    overrides?: { method: string; minutes: number }[];
  };
  updated?: string; // RFC3339, from Google - used for last-write-wins
  recurringEventId?: string;
}

export interface MappedToNueco {
  /** Fields to merge into / create a CalendarEvent from. */
  event: Pick<
    CalendarEvent,
    | 'title'
    | 'description'
    | 'location'
    | 'start_time'
    | 'end_time'
    | 'all_day'
    | 'recurrence'
    | 'timezone'
    | 'reminder_minutes'
    | 'attendees'
    | 'google_event_updated'
  >;
  /** Present when something couldn't be fully represented - already appended to description. */
  degraded: string | null;
}

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']; // index = Nueco byweekday (0=Sun)

// ---------- Nueco -> Google ----------

/** Build the RRULE string for a Nueco recurrence, or null when there is none. */
export function recurrenceToRRule(rec: Recurrence | null | undefined, allDay: boolean): string | null {
  if (!rec) return null;
  const parts: string[] = [];
  switch (rec.freq) {
    case 'daily': parts.push('FREQ=DAILY'); break;
    case 'weekly': parts.push('FREQ=WEEKLY'); break;
    case 'monthly': parts.push('FREQ=MONTHLY'); break;
    case 'yearly': parts.push('FREQ=YEARLY'); break;
    default: return null;
  }
  if (rec.freq === 'weekly' && rec.byweekday && rec.byweekday.length > 0) {
    const days = rec.byweekday
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      .map((d) => DAY_CODES[d]);
    if (days.length > 0) parts.push(`BYDAY=${days.join(',')}`);
  }
  if (rec.until) {
    const dateOnly = rec.until.slice(0, 10).replace(/-/g, '');
    if (dateOnly.length === 8) {
      // RFC 5545: UNTIL's value type should match DTSTART. All-day → bare date (inclusive),
      // timed → end-of-that-day as UTC datetime so the whole final day is covered.
      parts.push(allDay ? `UNTIL=${dateOnly}` : `UNTIL=${dateOnly}T235959Z`);
    }
  }
  return parts.join(';');
}

/**
 * Map a Nueco event to a Google event resource for create/update.
 * `calendarTimeZone` is the calendar's own IANA zone, used as fallback when the event has none
 * (Google needs a timeZone on timed events to anchor DST-sensitive recurrences).
 */
export function nuecoEventToGoogle(
  event: CalendarEvent,
  calendarTimeZone: string | null
): GoogleEventResource {
  const resource: GoogleEventResource = {
    summary: event.title,
    description: event.description || undefined,
    location: event.location || undefined,
  };

  if (event.all_day) {
    // Both sides use the iCal convention: end date is exclusive (day after the last day).
    resource.start = { date: event.start_time.slice(0, 10) };
    resource.end = { date: event.end_time.slice(0, 10) };
  } else {
    const tz = event.timezone || calendarTimeZone || undefined;
    resource.start = { dateTime: event.start_time, ...(tz ? { timeZone: tz } : {}) };
    resource.end = { dateTime: event.end_time, ...(tz ? { timeZone: tz } : {}) };
  }

  const rrule = recurrenceToRRule(event.recurrence, !!event.all_day);
  if (rrule) resource.recurrence = [rrule];

  if (event.reminder_minutes != null && event.reminder_minutes > 0) {
    resource.reminders = {
      useDefault: false,
      overrides: [{ method: 'popup', minutes: event.reminder_minutes }],
    };
  } else {
    resource.reminders = { useDefault: true };
  }

  // Attendees are mirrored read-only from Google; never push Nueco-side attendee changes.
  return resource;
}

// ---------- Google -> Nueco ----------

function parseRRuleParts(rrule: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of rrule.replace(/^RRULE:/i, '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).toUpperCase()] = part.slice(idx + 1);
  }
  return out;
}

/**
 * Parse a Google recurrence array into a Nueco Recurrence. Returns null plus a reason string
 * when the rule can't be represented (caller degrades to a single occurrence + note).
 */
export function rruleToRecurrence(
  recurrence: string[] | undefined,
  startDateTime: string | undefined
): { recurrence: Recurrence | null; unsupported: string | null } {
  if (!recurrence || recurrence.length === 0) return { recurrence: null, unsupported: null };
  const rrule = recurrence.find((r) => r.toUpperCase().startsWith('RRULE'));
  if (!rrule) return { recurrence: null, unsupported: 'no RRULE found' };
  if (recurrence.filter((r) => r.toUpperCase().startsWith('RRULE')).length > 1) {
    return { recurrence: null, unsupported: 'multiple RRULEs' };
  }
  if (recurrence.some((r) => /^(EXDATE|EXRULE|RDATE)/i.test(r.trim()))) {
    return { recurrence: null, unsupported: 'exception dates (EXDATE/RDATE)' };
  }

  const p = parseRRuleParts(rrule);
  const freq = p['FREQ'];
  let nuecoFreq: Recurrence['freq'];
  switch (freq) {
    case 'DAILY': nuecoFreq = 'daily'; break;
    case 'WEEKLY': nuecoFreq = 'weekly'; break;
    case 'MONTHLY': nuecoFreq = 'monthly'; break;
    case 'YEARLY': nuecoFreq = 'yearly'; break;
    default: return { recurrence: null, unsupported: `frequency ${freq || '(none)'}` };
  }

  const blockers: string[] = [];
  if (p['INTERVAL'] && p['INTERVAL'] !== '1') blockers.push(`INTERVAL=${p['INTERVAL']}`);
  if (p['COUNT']) blockers.push(`COUNT=${p['COUNT']}`);
  if (p['BYMONTHDAY']) blockers.push(`BYMONTHDAY=${p['BYMONTHDAY']}`);
  if (p['BYSETPOS']) blockers.push(`BYSETPOS=${p['BYSETPOS']}`);
  if (p['BYMONTH']) blockers.push(`BYMONTH=${p['BYMONTH']}`);
  if (p['BYHOUR'] || p['BYMINUTE']) blockers.push('BYHOUR/BYMINUTE');
  if (nuecoFreq !== 'weekly' && p['BYDAY']) blockers.push(`BYDAY=${p['BYDAY']}`);
  if (blockers.length > 0) return { recurrence: null, unsupported: blockers.join(', ') };

  let byweekday: number[] | null = null;
  if (nuecoFreq === 'weekly' && p['BYDAY']) {
    const codes = p['BYDAY'].split(',').map((s) => s.trim().toUpperCase());
    const idx = codes.map((c) => DAY_CODES.indexOf(c)).filter((i) => i >= 0);
    if (idx.length !== codes.length) {
      return { recurrence: null, unsupported: `BYDAY=${p['BYDAY']}` };
    }
    byweekday = idx;
  }

  let until: string | null = null;
  if (p['UNTIL']) {
    // UNTIL=YYYYMMDD or YYYYMMDDTHHMMSSZ → ISO date (inclusive day).
    const u = p['UNTIL'];
    if (/^\d{8}/.test(u)) {
      until = `${u.slice(0, 4)}-${u.slice(4, 6)}-${u.slice(6, 8)}`;
    }
  }
  if (!until && p['COUNT']) {
    return { recurrence: null, unsupported: `COUNT=${p['COUNT']}` };
  }

  return { recurrence: { freq: nuecoFreq, byweekday, until }, unsupported: null };
}

/** Mirror Google attendees into the Nueco read-only subset. */
export function mapAttendees(
  attendees: GoogleEventResource['attendees']
): GoogleAttendee[] | null {
  if (!attendees || attendees.length === 0) return null;
  const mapped = attendees
    .filter((a) => !!a.email)
    .map((a) => ({
      email: a.email as string,
      ...(a.displayName ? { displayName: a.displayName } : {}),
      ...(a.responseStatus
        ? { responseStatus: a.responseStatus as GoogleAttendee['responseStatus'] }
        : {}),
      ...(a.organizer ? { organizer: true } : {}),
      ...(a.self ? { self: true } : {}),
    }));
  return mapped.length > 0 ? mapped : null;
}

/**
 * Map one Google event resource to Nueco fields. `googleEventId` is decided by the CALLER
 * (recurring instances vs master choice), not derived here.
 */
export function googleEventToNueco(g: GoogleEventResource): MappedToNueco {
  const allDay = !!(g.start?.date && g.end?.date);
  const start_time = allDay ? (g.start?.date as string) : (g.start?.dateTime ?? '');
  const end_time = allDay ? (g.end?.date as string) : (g.end?.dateTime ?? '');
  const timezone = !allDay ? (g.start?.timeZone ?? null) : null;

  let degraded: string | null = null;
  let recurrence: Recurrence | null = null;
  const { recurrence: parsed, unsupported } = rruleToRecurrence(g.recurrence, g.start?.dateTime);
  if (unsupported) {
    degraded = `(Imported from Google Calendar: repeats with ${unsupported}, which Nueco can't repeat yet - saved as a single occurrence.)`;
  } else {
    recurrence = parsed;
  }

  let description = g.description || '';
  if (degraded) description = description ? `${description}\n\n${degraded}` : degraded;

  // Reminder: Nueco models a single popup offset; take the smallest popup override.
  let reminder_minutes: ReminderMinutes | null = null;
  const overrides = g.reminders?.overrides ?? [];
  const popups = overrides.filter((o) => o.method === 'popup' && Number.isFinite(o.minutes));
  if (!g.reminders?.useDefault && popups.length > 0) {
    reminder_minutes = snapReminder(Math.min(...popups.map((o) => o.minutes)));
  }

  return {
    event: {
      title: g.summary || '(No title)',
      description,
      location: g.location || '',
      start_time,
      end_time,
      all_day: allDay,
      recurrence,
      timezone,
      reminder_minutes,
      attendees: mapAttendees(g.attendees),
      google_event_updated: g.updated ?? null,
    },
    degraded,
  };
}
