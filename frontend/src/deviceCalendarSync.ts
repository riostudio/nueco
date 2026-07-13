import { Platform } from 'react-native';
import { requestCalendarAccountSync } from '../modules/calendar-account-sync';
import { getLocalEvents } from './offlineSync';
import { nextOccurrenceOnOrAfter } from './recurrence';
import type { CalendarEvent } from './types';

let ExpoCalendar: typeof import('expo-calendar') | null = null;
if (Platform.OS !== 'web') {
  try { ExpoCalendar = require('expo-calendar'); } catch {}
}

// Nudges Android's account sync adapter for every synced calendar on the device, right after a
// device-calendar write/delete, so the change reaches Google/Exchange servers immediately instead
// of waiting for the OS's normal periodic sync window. Best-effort: no-op on iOS/web, and swallows
// errors - this is a speedup, not something a save/delete should ever fail over.
export async function bumpDeviceCalendarSync(): Promise<void> {
  if (Platform.OS !== 'android' || !ExpoCalendar) return;
  try {
    const cals = await ExpoCalendar.getCalendarsAsync(ExpoCalendar.EntityTypes.EVENT);
    const seen = new Set<string>();
    for (const c of cals as any[]) {
      if (c.source?.isLocalAccount === true || !c.source?.name || !c.source?.type) continue;
      const key = `${c.source.name}|${c.source.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      requestCalendarAccountSync(c.source.name, c.source.type);
    }
  } catch {}
}

// Rolls every recurring event's device-calendar entry forward to its current next
// occurrence. `event-editor.tsx`'s `writeToDeviceCalendar` handles the "just
// created/edited" half of the "device calendar always shows the upcoming occurrence"
// contract; this is the periodic-refresh half, for recurring events whose editor isn't
// open right now - called on every app foreground (see `app/(tabs)/_layout.tsx`,
// alongside `runCalendarSync()`) since there's no cron/background job in this app that
// could otherwise do it. Best-effort throughout: this is a backup/belt-and-suspenders
// calendar entry, not the record of truth (the server event is), so a failure here
// (permission revoked, the device-calendar entry was deleted by the user, etc.) is
// swallowed per-event rather than surfaced - it can't regress anything, it just means
// that one entry stays stale until the next successful refresh or the user reopens
// that event's editor.
export async function refreshRecurringDeviceCalendarEntries(): Promise<void> {
  if (Platform.OS === 'web' || !ExpoCalendar) return;
  let wroteAny = false;
  try {
    const events = await getLocalEvents();
    const now = new Date();
    for (const event of events) {
      if (event._pendingDelete || !event.recurrence || !event.device_calendar_event_id) continue;
      try {
        const start = new Date(event.start_time);
        const end = new Date(event.end_time);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
        const durationMs = end.getTime() - start.getTime();

        // `nextOccurrenceOnOrAfter` only reads `start_time`/`recurrence`/`timezone` off its
        // argument - LocalEvent carries all three but isn't a full CalendarEvent (no `id`/
        // `created_at`/etc.), hence the cast.
        const pseudoEvent = {
          start_time: event.start_time,
          recurrence: event.recurrence,
          timezone: event.timezone ?? null,
        } as unknown as CalendarEvent;

        const next = nextOccurrenceOnOrAfter(pseudoEvent, now);
        if (!next) continue; // recurrence has ended (past `until`) - leave the last-written entry as-is

        const nextEnd = new Date(next.getTime() + durationMs);
        await ExpoCalendar.updateEventAsync(event.device_calendar_event_id, {
          title: event.title,
          notes: event.description,
          location: event.location || '',
          startDate: next,
          endDate: nextEnd,
          timeZone: event.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
        wroteAny = true;
      } catch (e) {
        console.error('Failed to refresh recurring device-calendar entry for event', event.id, e);
      }
    }
  } catch (e) {
    console.error('refreshRecurringDeviceCalendarEntries failed:', e);
  }
  if (wroteAny) await bumpDeviceCalendarSync();
}
