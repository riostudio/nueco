/**
 * google/googleSync.ts
 * Two-way sync between Nueco events and ONE selected Google calendar, using the client-side
 * Google Calendar API (the Nueco backend is never involved - see auth.ts/calendarApi.ts).
 *
 * Outbound: saveEventToGoogle/deleteEventFromGoogle are called from the event save/delete
 * paths. Failures (offline, transient API errors) land in a persistent retry queue that is
 * flushed at the start of every sync run, so a failed push never gets lost.
 *
 * Inbound: runGoogleSync pulls master events (recurring series as one item) for the same
 * -7/+180-day window device sync uses, matches them to Nueco events by google_event_id, and:
 *   - creates Nueco events for new Google events,
 *   - applies Google-side edits when Google's `updated` is newer than what we last saw
 *     (google_event_updated),
 *   - mirrors deletions conservatively: only for events whose start falls inside the fetched
 *     window, and only when the fetch completed.
 *
 * Conflict policy is last-write-wins on the Google side: outbound pushes always overwrite the
 * Google event, inbound applies Google changes only when they're newer than our last recorded
 * view of that event. A local edit not yet pushed can therefore be overwritten by a newer
 * Google-side edit - acceptable for a personal calendar, and visible in the description/fields
 * rather than silently half-applied.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CalendarEvent } from '../types';
import { getValidAccessToken, isGoogleConnected, disconnectGoogleAccount } from './auth';
import {
  GoogleApiError,
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
} from './calendarApi';
import { nuecoEventToGoogle, googleEventToNueco } from './eventMapper';
import {
  createEventOffline,
  updateEventOffline,
  deleteEventOffline,
  getLocalEvents,
  type LocalEvent,
} from '../offlineSync';
import { eventsApi } from '../api';

const KEYS = {
  SELECTED: 'google_sync_selected_calendar',
  RETRY_QUEUE: 'google_sync_retry_queue',
  LAST_RUN_AT: 'google_sync_last_run_at',
  LOCK: 'google_sync_lock',
};

const THROTTLE_MS = 15 * 60 * 1000; // same cadence as device-calendar sync
const LOCK_TTL_MS = 5 * 60 * 1000;
const WINDOW_PAST_DAYS = 7;
const WINDOW_FUTURE_DAYS = 180;

export interface SelectedGoogleCalendar {
  id: string;
  summary: string;
  timeZone: string | null;
}

type RetryItem = { kind: 'push' | 'delete'; event: CalendarEvent };

// ---------- Selected calendar ----------

export async function getSelectedGoogleCalendar(): Promise<SelectedGoogleCalendar | null> {
  try {
    const raw = await AsyncStorage.getItem(KEYS.SELECTED);
    return raw ? (JSON.parse(raw) as SelectedGoogleCalendar) : null;
  } catch {
    return null;
  }
}

export async function setSelectedGoogleCalendar(cal: SelectedGoogleCalendar | null): Promise<void> {
  if (cal) await AsyncStorage.setItem(KEYS.SELECTED, JSON.stringify(cal));
  else await AsyncStorage.removeItem(KEYS.SELECTED);
}

/** True when Google Calendar sync is actually active (connected + calendar chosen). */
export async function isGoogleSyncActive(): Promise<boolean> {
  if (!(await isGoogleConnected())) return false;
  return !!(await getSelectedGoogleCalendar());
}

// ---------- Retry queue ----------

async function readRetryQueue(): Promise<RetryItem[]> {
  try {
    const raw = await AsyncStorage.getItem(KEYS.RETRY_QUEUE);
    return raw ? (JSON.parse(raw) as RetryItem[]) : [];
  } catch {
    return [];
  }
}

async function writeRetryQueue(queue: RetryItem[]): Promise<void> {
  await AsyncStorage.setItem(KEYS.RETRY_QUEUE, JSON.stringify(queue));
}

async function enqueueRetry(item: RetryItem): Promise<void> {
  const queue = await readRetryQueue();
  // Replace any queued op for the same event - only the newest matters.
  queue.push(item);
  await writeRetryQueue(queue.filter((q, i) => !(q.event.id === item.event.id && i !== queue.length - 1)));
}

async function flushRetryQueue(token: string, selected: SelectedGoogleCalendar): Promise<void> {
  const queue = await readRetryQueue();
  if (queue.length === 0) return;
  const remaining: RetryItem[] = [];
  for (const item of queue) {
    try {
      if (item.kind === 'push') {
        await pushNow(token, selected, item.event);
      } else {
        await deleteNow(token, selected, item.event);
      }
    } catch (e) {
      if (e instanceof GoogleApiError && !e.retryable) continue; // gone for good - drop it
      remaining.push(item);
    }
  }
  await writeRetryQueue(remaining);
}

// ---------- Outbound ----------

/**
 * Fill in google_event_id/google_calendar_id/google_event_updated from the locally stored copy
 * when the caller's payload doesn't carry them (the common case: save paths build fresh event
 * data and the bridge fields only exist on the stored event after a previous successful push).
 */
async function mergeBridgeFields(event: CalendarEvent): Promise<CalendarEvent> {
  if (event.google_event_id) return event;
  try {
    const local = (await getLocalEvents()).find((e) => e.id === event.id);
    if (!local?.google_event_id) return event;
    return {
      ...event,
      google_event_id: local.google_event_id,
      google_calendar_id: local.google_calendar_id ?? null,
      google_event_updated: local.google_event_updated ?? null,
    };
  } catch {
    return event;
  }
}

async function writeBackBridgeFields(
  eventId: string,
  bridge: { google_event_id: string; google_calendar_id: string; google_event_updated: string | null }
): Promise<void> {
  try {
    await updateEventOffline(eventId, bridge, { push: true });
  } catch (e) {
    console.warn('Google sync: failed to write back bridge fields', e);
  }
}

async function pushNow(
  token: string,
  selected: SelectedGoogleCalendar,
  event: CalendarEvent
): Promise<void> {
  const resource = nuecoEventToGoogle(event, selected.timeZone);
  if (event.google_event_id && event.google_calendar_id === selected.id) {
    const updated = await updateEvent(token, selected.id, event.google_event_id, resource);
    await writeBackBridgeFields(event.id, {
      google_event_id: event.google_event_id,
      google_calendar_id: selected.id,
      google_event_updated: updated.updated ?? null,
    });
  } else {
    const created = await createEvent(token, selected.id, resource);
    if (!created.id) throw new GoogleApiError('Google create returned no id', 0, true);
    await writeBackBridgeFields(event.id, {
      google_event_id: created.id,
      google_calendar_id: selected.id,
      google_event_updated: created.updated ?? null,
    });
  }
}

async function deleteNow(
  token: string,
  selected: SelectedGoogleCalendar,
  event: CalendarEvent
): Promise<void> {
  if (event.google_event_id) {
    try {
      await deleteEvent(token, event.google_calendar_id || selected.id, event.google_event_id);
    } catch (e) {
      // 404/410: already gone on Google - that's the desired end state.
      if (e instanceof GoogleApiError && (e.status === 404 || e.status === 410)) return;
      throw e;
    }
  }
}

/**
 * Mirror a saved Nueco event to Google. Fire-and-forget safe: never throws to the caller;
 * failures queue for retry on the next sync run.
 */
export async function saveEventToGoogle(event: CalendarEvent): Promise<void> {
  try {
    if (!(await isGoogleSyncActive())) return;
    const token = await getValidAccessToken();
    if (!token) return;
    const selected = await getSelectedGoogleCalendar();
    if (!selected) return;
    // Callers often pass freshly built event data that lacks the bridge fields (they live on the
    // stored copy, written back after the first successful push). Pull them from the local store
    // so a re-save updates the same Google event instead of creating a duplicate.
    const withBridge = await mergeBridgeFields(event);
    await pushNow(token, selected, withBridge);
  } catch (e) {
    if (e instanceof GoogleApiError && !e.retryable) return;
    await enqueueRetry({ kind: 'push', event: await mergeBridgeFields(event) });
  }
}

/** Mirror a Nueco event deletion to Google. Same never-throw contract as saveEventToGoogle. */
export async function deleteEventFromGoogle(event: CalendarEvent): Promise<void> {
  try {
    const withBridge = await mergeBridgeFields(event);
    if (!withBridge.google_event_id) return;
    if (!(await isGoogleConnected())) return;
    const token = await getValidAccessToken();
    if (!token) return;
    const selected = await getSelectedGoogleCalendar();
    if (!selected) return;
    await deleteNow(token, selected, withBridge);
  } catch (e) {
    if (e instanceof GoogleApiError && !e.retryable) return;
    await enqueueRetry({ kind: 'delete', event: await mergeBridgeFields(event) });
  }
}

// ---------- Inbound ----------

function toIso(d: Date): string {
  return d.toISOString();
}

function withinWindow(startTime: string, timeMin: string, timeMax: string): boolean {
  return startTime >= timeMin && startTime < timeMax;
}

/**
 * One inbound+retry sync run. Throttled like device sync; `force` bypasses the throttle (used
 * by the settings screen's "Sync now"). Never throws.
 */
export async function runGoogleSync(opts: { force?: boolean } = {}): Promise<void> {
  try {
    if (!(await isGoogleSyncActive())) return;
    if (!opts.force) {
      const last = await AsyncStorage.getItem(KEYS.LAST_RUN_AT);
      if (last && Date.now() - new Date(last).getTime() < THROTTLE_MS) return;
    }
    const lock = await AsyncStorage.getItem(KEYS.LOCK);
    if (lock && Date.now() - new Date(lock).getTime() < LOCK_TTL_MS) return;
    await AsyncStorage.setItem(KEYS.LOCK, new Date().toISOString());

    try {
      const token = await getValidAccessToken();
      if (!token) return; // connection died mid-way; auth.ts already cleared tokens
      const selected = await getSelectedGoogleCalendar();
      if (!selected) return;

      await flushRetryQueue(token, selected);

      const timeMin = toIso(new Date(Date.now() - WINDOW_PAST_DAYS * 24 * 3600 * 1000));
      const timeMax = toIso(new Date(Date.now() + WINDOW_FUTURE_DAYS * 24 * 3600 * 1000));
      const googleEvents = await listEvents(token, selected.id, timeMin, timeMax);

      // The WHOLE Nueco collection - same reasoning as device sync: a partial read makes
      // unmatched Google events look new and duplicates them.
      const memoPull = await eventsApi.getAllPaged();
      if (!memoPull.complete) {
        console.warn('Google sync: could not read every Nueco event; skipping this run');
        return;
      }
      const localEvents = memoPull.items as LocalEvent[];
      const byGoogleId = new Map<string, LocalEvent>();
      for (const ev of localEvents) {
        if (ev.google_event_id) byGoogleId.set(ev.google_event_id, ev);
      }

      const seenGoogleIds = new Set<string>();

      for (const g of googleEvents) {
        if (!g.id) continue;

        if (g.status === 'cancelled') {
          const local = byGoogleId.get(g.id);
          if (local) {
            try {
              await deleteEventOffline(local.id, { push: true });
            } catch (e) {
              console.warn('Google sync: failed to mirror deletion', e);
            }
          }
          continue;
        }

        seenGoogleIds.add(g.id);
        const mapped = googleEventToNueco(g);
        const local = byGoogleId.get(g.id);

        if (local) {
          // Last-write-wins: apply the Google side only when it changed since we last saw it.
          const googleUpdated = g.updated ?? '';
          const lastSeen = local.google_event_updated ?? '';
          if (googleUpdated > lastSeen) {
            try {
              await updateEventOffline(
                local.id,
                {
                  ...mapped.event,
                  google_event_id: g.id,
                  google_calendar_id: selected.id,
                  google_event_updated: googleUpdated || null,
                },
                { push: true }
              );
            } catch (e) {
              console.warn('Google sync: failed to apply update', e);
            }
          }
        } else {
          try {
            await createEventOffline(
              {
                ...mapped.event,
                linked_note_ids: [],
                device_calendar_event_id: null,
                trip_id: null,
                google_event_id: g.id,
                google_calendar_id: selected.id,
                google_event_updated: g.updated ?? null,
              },
              { push: true }
            );
          } catch (e) {
            console.warn('Google sync: failed to import event', e);
          }
        }
      }

      // Conservative deletion: a Nueco event we previously synced FROM this Google calendar,
      // whose start falls inside the fetched window, but which is no longer on Google
      // (and wasn't reported cancelled above) was deleted there - mirror that.
      for (const ev of localEvents) {
        if (!ev.google_event_id || ev.google_calendar_id !== selected.id) continue;
        if (seenGoogleIds.has(ev.google_event_id)) continue;
        if (!withinWindow(ev.start_time, timeMin, timeMax)) continue;
        try {
          await deleteEventOffline(ev.id, { push: true });
        } catch (e) {
          console.warn('Google sync: failed to mirror missing event', e);
        }
      }

      await AsyncStorage.setItem(KEYS.LAST_RUN_AT, new Date().toISOString());
    } finally {
      await AsyncStorage.removeItem(KEYS.LOCK);
    }
  } catch (e) {
    console.error('Google sync run failed:', e);
  }
}

/**
 * Full disconnect: revoke the grant, wipe local sync state (selected calendar + retry queue +
 * throttle markers). Bridge fields on events are deliberately KEPT - the events themselves are
 * the user's data; only the sync relationship goes away.
 */
export async function disconnectGoogleSync(): Promise<void> {
  await disconnectGoogleAccount(true);
  await AsyncStorage.multiRemove([
    KEYS.SELECTED,
    KEYS.RETRY_QUEUE,
    KEYS.LAST_RUN_AT,
    KEYS.LOCK,
  ]);
}
