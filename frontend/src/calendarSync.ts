/**
 * calendarSync.ts
 * Opt-in background + foreground sync of device calendar events (Apple/Google/Outlook - whatever
 * the OS Calendar app knows about) into Nueco, layered on top of the manual "Import from
 * Calendar" picker in event-editor.tsx. Disabled and empty-selection by default.
 *
 * Matching a device event to a Nueco event reuses the existing `device_calendar_event_id` field
 * (the same one the manual import + device-calendar export paths already populate). A device event
 * that disappears at the source has its Nueco copy deleted too (via the offline queue, so it
 * survives being offline) - but only when we're confident the disappearance is real:
 *  - the selected-calendar set must be unchanged since the last run (otherwise a user deselecting
 *    a calendar in settings would look identical to every one of its events being deleted), and
 *  - this run's device event fetch must have returned at least one event (guards against a
 *    transient empty/failed read - e.g. a mid-flight account sync - being misread as "everything
 *    was deleted"). This runs unattended, so it must stay conservative about destructive action.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { eventsApi } from './api';
import { encryptEventForServer } from './crypto/eventCrypto';
import { deleteEventOffline } from './offlineSync';
import { bumpDeviceCalendarSync } from './deviceCalendarSync';
import { isCalendarSelectionUnchanged, planCalendarSync, type DeviceEvent } from './calendarSyncCore';

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
  LAST_CALENDAR_IDS: 'calendar_sync_last_calendar_ids',
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

// Called on logout. These keys are plain (not user-scoped) AsyncStorage, so on a shared device
// the next account to log in would otherwise inherit the previous user's sync opt-in + calendar
// selection and silently push their device-calendar events into the new account.
export async function resetCalendarSyncState(): Promise<void> {
  await AsyncStorage.multiRemove([KEYS.ENABLED, KEYS.CALENDAR_IDS, KEYS.EVENT_HASHES, KEYS.LAST_RUN_AT, KEYS.LOCK, KEYS.LAST_CALENDAR_IDS]);
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
 * `THROTTLE_MS` unless `force` is passed. Never deletes a Nueco event.
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

      // Best-effort nudge so Android pulls fresh Google/Exchange changes down to the device
      // calendar before we read it - doesn't block this run (the sync it kicks off completes
      // later), but keeps the device calendar fresher for this and the next run.
      bumpDeviceCalendarSync();

      const rangeStart = new Date(); rangeStart.setDate(rangeStart.getDate() - WINDOW_PAST_DAYS);
      const rangeEnd = new Date(); rangeEnd.setDate(rangeEnd.getDate() + WINDOW_FUTURE_DAYS);
      const deviceEvents = await ExpoCalendar.getEventsAsync(calendarIds, rangeStart, rangeEnd);

      // Existing Nueco events, keyed by the device event id they were created/synced from.
      //
      // This has to be the WHOLE collection. An event missing from it reads as "never imported",
      // and the plan below then re-creates it - so a pull that stopped early duplicates every
      // imported event it failed to reach. (It used to stop early every time: the response is
      // paginated at 100, and this read one page and assumed it was everything.) Rather than
      // duplicate, give up and let the next run try again - nothing is written until the plan is
      // applied, so bailing here costs only the run.
      const memoPull = await eventsApi.getAllPaged();
      if (!memoPull.complete) {
        console.warn('Calendar sync: could not read every Nueco event; skipping this run');
        return;
      }
      const memoEvents: any[] = memoPull.items;
      const byDeviceId = new Map<string, any>();
      for (const ev of memoEvents) {
        if (ev.device_calendar_event_id) byDeviceId.set(ev.device_calendar_event_id, ev);
      }

      const hashes = await readHashes();
      const currentIdsKey = JSON.stringify([...calendarIds].sort());
      const storedIdsKey = await AsyncStorage.getItem(KEYS.LAST_CALENDAR_IDS);
      const selectionUnchanged = isCalendarSelectionUnchanged(storedIdsKey, currentIdsKey, Object.keys(hashes).length > 0);

      const { nextHashes, actions } = planCalendarSync(deviceEvents as DeviceEvent[], byDeviceId, hashes, selectionUnchanged);

      for (const action of actions) {
        try {
          if (action.kind === 'update') {
            await eventsApi.update(action.memoId, await encryptEventForServer(action.payload));
          } else if (action.kind === 'create') {
            await eventsApi.create(await encryptEventForServer(action.payload));
          } else {
            await deleteEventOffline(action.memoId, { push: true });
          }
        } catch (e) {
          console.error('Calendar sync: failed to apply action', action, e);
          // Don't mark this device event as "seen" - keep (or drop) the prior hash so the
          // create/update/delete is retried next run.
          if (hashes[action.deviceId]) nextHashes[action.deviceId] = hashes[action.deviceId];
          else delete nextHashes[action.deviceId];
        }
      }

      await AsyncStorage.setItem(KEYS.EVENT_HASHES, JSON.stringify(nextHashes));
      await AsyncStorage.setItem(KEYS.LAST_CALENDAR_IDS, currentIdsKey);
      await AsyncStorage.setItem(KEYS.LAST_RUN_AT, new Date().toISOString());
    } finally {
      await AsyncStorage.removeItem(KEYS.LOCK);
    }
  } catch (e) {
    console.error('Calendar sync failed:', e);
  }
}
