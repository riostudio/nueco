/**
 * calendarSync.ts
 * Opt-in background + foreground sync of device calendar events (Apple/Google/Outlook - whatever
 * the OS Calendar app knows about) into MemoPad, layered on top of the manual "Import from
 * Calendar" picker in event-editor.tsx. Disabled and empty-selection by default.
 *
 * Matching a device event to a MemoPad event reuses the existing `device_calendar_event_id` field
 * (the same one the manual import + device-calendar export paths already populate). A device event
 * that disappears at the source is dropped from the local hash map but its MemoPad copy is never
 * auto-deleted - this runs unattended, so it must not take destructive action.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { eventsApi } from './api';
import { encryptEventForServer } from './crypto/eventCrypto';

let ExpoCalendar: typeof import('expo-calendar') | null = null;
if (Platform.OS !== 'web') {
  try { ExpoCalendar = require('expo-calendar'); } catch {}
}

const KEYS = {
  ENABLED: 'calendar_sync_enabled',
  CALENDAR_IDS: 'calendar_sync_calendar_ids',
  EVENT_HASHES: 'calendar_sync_event_hashes',
  LAST_RUN_AT: 'calendar_sync_last_run_at',
  LOCK: 'calendar_sync_lock',
};

const THROTTLE_MS = 15 * 60 * 1000;
// Storage-based lock (not just an in-memory flag): iOS can invoke a background task in a separate
// headless JS context from the foreground app, so an in-memory guard wouldn't cross that boundary.
const LOCK_TTL_MS = 2 * 60 * 1000;
const WINDOW_PAST_DAYS = 7;
const WINDOW_FUTURE_DAYS = 180;

export async function isCalendarSyncEnabled(): Promise<boolean> {
  return (await AsyncStorage.getItem(KEYS.ENABLED)) === '1';
}

export async function setCalendarSyncEnabled(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(KEYS.ENABLED, enabled ? '1' : '0');
}

export async function getSyncedCalendarIds(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(KEYS.CALENDAR_IDS);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function setSyncedCalendarIds(ids: string[]): Promise<void> {
  await AsyncStorage.setItem(KEYS.CALENDAR_IDS, JSON.stringify(ids));
}

// Every device calendar the OS knows about (Apple/Google/Outlook/etc. - anything the user has
// added as an account in their phone's Calendar settings), for the sync-settings checklist.
export async function getAllDeviceCalendars(): Promise<{ id: string; title: string; source?: string }[]> {
  if (!ExpoCalendar || Platform.OS === 'web') return [];
  let status = (await ExpoCalendar.getCalendarPermissionsAsync()).status;
  if (status !== 'granted') {
    status = (await ExpoCalendar.requestCalendarPermissionsAsync()).status;
  }
  if (status !== 'granted') return [];
  const all = await ExpoCalendar.getCalendarsAsync(ExpoCalendar.EntityTypes.EVENT);
  return all.map((c: any) => ({ id: c.id as string, title: c.title as string, source: c.source?.name as string | undefined }));
}

function hashDeviceEvent(e: { title: string; location: string; notes: string; startDate: string | Date; endDate: string | Date }): string {
  return [e.title, e.location, e.notes, new Date(e.startDate).toISOString(), new Date(e.endDate).toISOString()].join('|');
}

async function readHashes(): Promise<Record<string, string>> {
  try {
    const raw = await AsyncStorage.getItem(KEYS.EVENT_HASHES);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/**
 * Pull in new/changed events from the selected device calendars. Safe to call often - it's a
 * no-op unless sync is enabled with at least one calendar selected, and throttles to once per
 * `THROTTLE_MS` unless `force` is passed. Never deletes a MemoPad event.
 */
export async function runCalendarSync(opts: { force?: boolean } = {}): Promise<void> {
  if (!ExpoCalendar || Platform.OS === 'web') return;
  try {
    if (!(await isCalendarSyncEnabled())) return;
    const calendarIds = await getSyncedCalendarIds();
    if (!calendarIds.length) return;

    if (!opts.force) {
      const lastRunAt = await AsyncStorage.getItem(KEYS.LAST_RUN_AT);
      if (lastRunAt && Date.now() - new Date(lastRunAt).getTime() < THROTTLE_MS) return;
    }

    const existingLock = await AsyncStorage.getItem(KEYS.LOCK);
    if (existingLock && Date.now() - new Date(existingLock).getTime() < LOCK_TTL_MS) return;
    await AsyncStorage.setItem(KEYS.LOCK, new Date().toISOString());

    try {
      const status = (await ExpoCalendar.getCalendarPermissionsAsync()).status;
      if (status !== 'granted') return;

      const rangeStart = new Date(); rangeStart.setDate(rangeStart.getDate() - WINDOW_PAST_DAYS);
      const rangeEnd = new Date(); rangeEnd.setDate(rangeEnd.getDate() + WINDOW_FUTURE_DAYS);
      const deviceEvents = await ExpoCalendar.getEventsAsync(calendarIds, rangeStart, rangeEnd);

      // Existing MemoPad events, keyed by the device event id they were created/synced from.
      // getAll() is capped at 100 server-side (pre-existing limit, not addressed here) - a user
      // with more than 100 real events could see an already-imported device event re-created.
      const memoEvents: any[] = await eventsApi.getAll();
      const byDeviceId = new Map<string, any>();
      for (const ev of memoEvents) {
        if (ev.device_calendar_event_id) byDeviceId.set(ev.device_calendar_event_id, ev);
      }

      const hashes = await readHashes();
      const nextHashes: Record<string, string> = {};

      for (const de of deviceEvents as any[]) {
        const hash = hashDeviceEvent({
          title: de.title || 'Untitled',
          location: de.location || '',
          notes: de.notes || '',
          startDate: de.startDate,
          endDate: de.endDate,
        });
        nextHashes[de.id] = hash;
        if (hashes[de.id] === hash) continue; // unchanged since last sync

        const match = byDeviceId.get(de.id);
        const payload = {
          title: de.title || 'Untitled',
          description: de.notes || '',
          location: de.location || '',
          start_time: new Date(de.startDate).toISOString(),
          end_time: new Date(de.endDate).toISOString(),
        };
        try {
          if (match) {
            // Deliberately not sending reminder_minutes/linked_note_ids, so a user's MemoPad-side
            // customizations on this event survive a resync.
            await eventsApi.update(match.id, await encryptEventForServer(payload));
          } else {
            await eventsApi.create(await encryptEventForServer({ ...payload, linked_note_ids: [], reminder_minutes: null, device_calendar_event_id: de.id }));
          }
        } catch (e) {
          console.error('Calendar sync: failed to sync event', de.id, e);
          // Don't mark this as "seen" - keep (or drop) the prior hash so it's retried next run.
          if (hashes[de.id]) nextHashes[de.id] = hashes[de.id];
          else delete nextHashes[de.id];
        }
      }
      // Device events that disappeared since last sync are simply dropped from the hash map -
      // their MemoPad copy is left alone (see file header).

      await AsyncStorage.setItem(KEYS.EVENT_HASHES, JSON.stringify(nextHashes));
      await AsyncStorage.setItem(KEYS.LAST_RUN_AT, new Date().toISOString());
    } finally {
      await AsyncStorage.removeItem(KEYS.LOCK);
    }
  } catch (e) {
    console.error('Calendar sync failed:', e);
  }
}
