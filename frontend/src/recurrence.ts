/**
 * Display-side recurrence helpers.
 *
 * IMPORTANT: this is deliberately NOT a full RRULE engine and is not the source of
 * truth for *when* a reminder fires - that's server-side (`backend/server.py`'s
 * `next_occurrence_on_or_after`, driven by `dateutil.rrule` + `zoneinfo`, wired
 * into the `push_tick` job). This module only needs to agree with the server
 * within about a day's granularity, since it's used purely to decide *which day*
 * to display a recurring event on (Events tab grouping, Calendar tab month-grid
 * dot + selected-day list) and how to describe it in prose.
 *
 * Approach: day-stepping is done in UTC-instant arithmetic (advance by whole
 * days from `event.start_time`), and `event.timezone` is consulted only to
 * determine which LOCAL CALENDAR DAY a candidate UTC instant falls into, for
 * comparing against `byweekday`/`until`. This avoids re-implementing wall-clock
 * DST-aware RRULE stepping in JS (the server already does that correctly); the
 * cost is that a reminder's date could theoretically be off by one calendar day
 * right at a DST boundary, which is acceptable for a display-only helper.
 */
import type { CalendarEvent, Recurrence } from './types';
import { DAY_NAMES, MONTH_NAMES } from './theme';

// Cap the day-stepping search so a no-`until` daily/weekly rule can't loop forever.
// Mirrors the spirit of the backend's `count=3650` cap (~10 years); we search a
// shorter 3-year window here since this is only ever used to find the *next*
// upcoming occurrence for display, not to enumerate a full rule.
const MAX_SEARCH_DAYS = 366 * 3;

/** Local {year, month (0-indexed), day} that `instant` falls on in `timeZone` (or device-local if omitted/invalid). */
function localCalendarDay(instant: Date, timeZone: string | null | undefined): { year: number; month: number; day: number } {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(instant);
      const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
      const year = get('year');
      const month = get('month'); // 1-indexed from Intl
      const day = get('day');
      if (!Number.isNaN(year) && !Number.isNaN(month) && !Number.isNaN(day)) {
        return { year, month: month - 1, day };
      }
    } catch {
      // Invalid/unknown IANA name - fall through to device-local below.
    }
  }
  return { year: instant.getFullYear(), month: instant.getMonth(), day: instant.getDate() };
}

/** JS `Date.getDay()`-style weekday (0=Sun..6=Sat) for a local calendar day. */
function localWeekday(cal: { year: number; month: number; day: number }): number {
  return new Date(cal.year, cal.month, cal.day).getDay();
}

function calDayLessOrEqual(a: { year: number; month: number; day: number }, b: { year: number; month: number; day: number }): boolean {
  if (a.year !== b.year) return a.year < b.year;
  if (a.month !== b.month) return a.month < b.month;
  return a.day <= b.day;
}

/**
 * Next occurrence (as a Date/UTC instant) of `event`'s recurrence at or after `from`,
 * or `null` if the event has no recurrence, or if `until` has already passed / no
 * matching occurrence exists within the search window.
 */
export function nextOccurrenceOnOrAfter(event: CalendarEvent, from: Date): Date | null {
  const recurrence = event.recurrence;
  if (!recurrence) return null;

  const start = new Date(event.start_time);
  if (Number.isNaN(start.getTime())) return null;

  const untilDay = recurrence.until ? parseIsoDateOnly(recurrence.until) : null;

  // Matches the backend's `dateutil.rrule` behavior: a weekly rule with no explicit
  // `byweekday` repeats on `start_time`'s own local weekday (not "every day") - see
  // `next_occurrence_on_or_after` in backend/server.py, which omits the `byweekday`
  // kwarg entirely in that case and lets rrule default to dtstart's weekday.
  const startDay = localCalendarDay(start, event.timezone);

  const weeklyDays =
    recurrence.byweekday && recurrence.byweekday.length > 0
      ? recurrence.byweekday
      : [localWeekday(startDay)];

  // Step in whole-day UTC-instant increments starting from `start`, never before it. Monthly/
  // yearly are matched the same way (day-of-month / month-and-day equal to dtstart's) rather
  // than jumping by calendar month/year - simpler, and MAX_SEARCH_DAYS (~3 years) comfortably
  // covers finding the next occurrence of either.
  const stepMs = 24 * 60 * 60 * 1000;
  let candidate = start.getTime() >= from.getTime() ? new Date(start.getTime()) : alignForward(start, from, stepMs);

  for (let i = 0; i < MAX_SEARCH_DAYS; i++) {
    const candDay = localCalendarDay(candidate, event.timezone);

    if (untilDay && !calDayLessOrEqual(candDay, untilDay)) {
      return null; // past the inclusive `until` boundary - no more occurrences
    }

    const matches =
      recurrence.freq === 'daily' ||
      (recurrence.freq === 'weekly' && weeklyDays.includes(localWeekday(candDay))) ||
      (recurrence.freq === 'monthly' && candDay.day === startDay.day) ||
      (recurrence.freq === 'yearly' && candDay.day === startDay.day && candDay.month === startDay.month);

    if (matches && candidate.getTime() >= from.getTime()) {
      return candidate;
    }

    candidate = new Date(candidate.getTime() + stepMs);
  }

  return null;
}

// Advance `start` forward by whole-day steps until it's >= `from` (keeps the
// original wall-clock-ish time-of-day offset from `start` rather than snapping to
// midnight, so the returned instant still reads as "the same time of day").
function alignForward(start: Date, from: Date, stepMs: number): Date {
  const diff = from.getTime() - start.getTime();
  const daysToAdvance = Math.max(0, Math.ceil(diff / stepMs));
  return new Date(start.getTime() + daysToAdvance * stepMs);
}

function parseIsoDateOnly(iso: string): { year: number; month: number; day: number } | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // `until` is an ISO date string (inclusive); treat it as a UTC calendar date to
  // avoid the local-timezone-of-the-parsing-device shifting it by a day.
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate() };
}

/**
 * True if a recurring `event` has an occurrence on the given local calendar date
 * (year, 0-indexed month, day - matching JS `Date` conventions, as used by the
 * Calendar tab's month-grid/day-list code). For a non-recurring event this isn't
 * meant to be called (callers already have `eventCoversDay` for that case), but it
 * returns `false` rather than throwing if it is.
 */
export function occursOnDay(event: CalendarEvent, year: number, month: number, day: number): boolean {
  if (!event.recurrence) return false;

  const dayStart = new Date(year, month, day, 0, 0, 0, 0);
  const dayEnd = new Date(year, month, day, 23, 59, 59, 999);

  // Find the next occurrence on/after the start of this local day; if it lands
  // within this same local day (by device-local time, matching the rest of
  // calendar.tsx's grid math), the event occurs on this day.
  const next = nextOccurrenceOnOrAfter(event, dayStart);
  if (!next) return false;
  return next.getTime() <= dayEnd.getTime();
}

// Matches any day the event spans, not just its start day - multi-day events (event-editor's
// End Date field) would otherwise vanish from every day but the first.
export function eventCoversDay(e: CalendarEvent, y: number, m: number, d: number): boolean {
  const dayStart = new Date(y, m, d, 0, 0, 0, 0);
  const dayEnd = new Date(y, m, d, 23, 59, 59, 999);
  return new Date(e.start_time) <= dayEnd && new Date(e.end_time) >= dayStart;
}

// Recurring events use the display-only occursOnDay helper (day-granularity, not the
// source of truth for reminder firing) instead of the plain start/end range check -
// eventCoversDay is left untouched for non-recurring events so their day-matching
// behavior stays byte-identical to before.
export function eventOccursOnDay(e: CalendarEvent, y: number, m: number, d: number): boolean {
  return e.recurrence ? occursOnDay(e, y, m, d) : eventCoversDay(e, y, m, d);
}

/** "Month Day, Year" - matches the date format already used across events.tsx/calendar.tsx (MONTH_NAMES-based). */
function formatMonthDayYear(cal: { year: number; month: number; day: number }): string {
  return `${MONTH_NAMES[cal.month]} ${cal.day}, ${cal.year}`;
}

/**
 * Human-readable summary of a recurrence rule, e.g. "Repeats daily",
 * "Repeats every Monday", "Repeats every Mon, Wed, Fri", optionally suffixed with
 * " until Jul 4, 2026"-style boundary text (reusing the existing MONTH_NAMES-based
 * date format used elsewhere in the app). Returns '' for `null` (no recurrence).
 */
export function formatRecurrenceSummary(recurrence: Recurrence | null): string {
  if (!recurrence) return '';

  let base: string;
  if (recurrence.freq === 'daily') {
    base = 'Repeats daily';
  } else if (recurrence.freq === 'monthly') {
    // Like the weekly no-explicit-days case below, this function only receives the
    // recurrence (not the event/start date), so the specific day-of-month isn't knowable here.
    base = 'Repeats monthly';
  } else if (recurrence.freq === 'yearly') {
    base = 'Repeats yearly';
  } else {
    const days = recurrence.byweekday ?? [];
    if (days.length === 7) {
      base = 'Repeats daily';
    } else if (days.length === 0) {
      // No explicit days: matches the backend's rrule fallback (repeats on
      // `start_time`'s own weekday) - but this function only receives the
      // recurrence, not the event, so the specific day isn't knowable here.
      base = 'Repeats weekly';
    } else if (days.length === 1) {
      base = `Repeats every ${fullDayName(days[0])}`;
    } else {
      const sorted = [...days].sort((a, b) => a - b);
      base = `Repeats every ${sorted.map((d) => DAY_NAMES[d]).join(', ')}`;
    }
  }

  if (recurrence.until) {
    const untilDay = parseIsoDateOnly(recurrence.until);
    if (untilDay) {
      base += ` until ${formatMonthDayYear(untilDay)}`;
    }
  }

  return base;
}

// `theme.ts`'s DAY_NAMES is abbreviated only ('Sun'..'Sat', matching the Calendar tab's
// grid header) - there's no full-name list anywhere in the codebase to reuse for the
// "Repeats every Monday" single-day case. Rather than either (a) also abbreviating the
// single-day case, losing the common calendar-app convention the plan called out with
// an explicit example, or (b) growing theme.ts's DAY_NAMES into a shape other callers
// (the grid header) don't want, this keeps a small local full-name list scoped to this
// one summary line. DAY_NAMES is still reused as-is for the multi-day/abbreviated case.
const FULL_DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function fullDayName(weekday: number): string {
  return FULL_DAY_NAMES[weekday] ?? DAY_NAMES[weekday] ?? '';
}
