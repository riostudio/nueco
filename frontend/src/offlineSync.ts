/**
 * offlineSync.ts
 * Nueco Offline Sync Manager
 *
 * Handles:
 * - Local storage of notes, events, and images via AsyncStorage
 * - A sync queue for pending create/update/delete operations
 * - Network detection and background sync
 * - Conflict resolution by most recent updated_at timestamp
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import NetInfo, { NetInfoState } from '@react-native-community/netinfo';
import uuid from 'react-native-uuid';
import { notesApi, eventsApi, tripsApi } from './api';
import { encryptNoteForServer, decryptNoteFromServer, decryptNotesFromServer } from './crypto/noteCrypto';
import { encryptEventForServer, decryptEventsFromServer } from './crypto/eventCrypto';
import { encryptTripForServer, decryptTripsFromServer } from './crypto/tripCrypto';
import { incrementNoteCreatedCount } from './feedbackToast';
import { mergeRecords, recordTimestamp } from './syncMergeCore';
import type { Recurrence, NoteObject } from './types';

// ---- Types ----

export type SyncOperation = 'create' | 'update' | 'delete';
export type SyncEntity = 'note' | 'event' | 'trip';

export interface SyncQueueItem {
  id: string;               // local temp ID (for creates) or server ID
  serverId?: string;        // set after first successful create
  entity: SyncEntity;
  operation: SyncOperation;
  payload?: any;            // the data to send
  timestamp: string;        // ISO - when queued
  retries: number;
}

export interface LocalNote {
  id: string;
  title: string;
  content: string;
  tags: any[];
  is_pinned: boolean;
  linked_event_id?: string | null; // Deprecated: use linked_event_ids. Kept for old clients/caches.
  linked_event_ids?: string[];
  images: string[];
  attachments?: any[];      // blob-storage attachment metadata (Attachment[])
  objects?: NoteObject[];   // free-floating image objects - see types.ts's NoteObject
  user_id?: string;
  created_at: string;
  updated_at: string;
  _isLocal?: boolean;       // true if not yet on server
  _pendingDelete?: boolean; // true if queued for deletion
}

export interface LocalEvent {
  id: string;
  title: string;
  description: string;
  location?: string;
  // Date-only "YYYY-MM-DD" when true (see CalendarEvent in types.ts for the full contract) -
  // start_time/end_time are never converted to/from local time in that case.
  all_day?: boolean;
  start_time: string;
  end_time: string;
  linked_note_ids: string[];
  reminder_minutes?: number | null;
  device_calendar_event_id?: string | null;
  recurrence?: Recurrence | null;
  timezone?: string | null;
  trip_id?: string | null; // Groups this event under a Trip - see LocalTrip below.
  // Local-only: the id returned by `Notifications.scheduleNotificationAsync` for this
  // event's reminder. Meaningful only on the device that scheduled it - never sent to or
  // read from the server (see `event-editor.tsx`'s `scheduleReminder`/`cancelLocalNotification`,
  // and the `fullSync` merge below, which re-attaches it after a server refresh would
  // otherwise silently drop it since the server never stores/returns this field).
  local_notification_id?: string | null;
  user_id?: string;
  created_at: string;
  // Every write to an event stamps this, and it is sent to the server, which stores it and
  // returns it (backfilled from created_at for events written before the field existed). Without
  // it the fullSync merge below had nothing to compare for events - only `created_at`, which
  // doesn't change on edit - so an already-synced event edited locally but not yet pushed lost to
  // the server's stale copy on the next pull. Optional because events already in a device's local
  // store predate the field.
  updated_at?: string;
  _isLocal?: boolean;
  _pendingDelete?: boolean;
}

export interface LocalTrip {
  id: string;
  name: string;
  description: string;
  user_id?: string;
  created_at: string;
  _isLocal?: boolean;
  _pendingDelete?: boolean;
}

// ---- Storage Keys ----

const KEYS = {
  NOTES: 'offline:notes',
  EVENTS: 'offline:events',
  TRIPS: 'offline:trips',
  SYNC_QUEUE: 'offline:syncQueue',
  LAST_SYNC: 'offline:lastSync',
};

// ---- File-backed JSON store ----
// AsyncStorage on Android is backed by SQLite, whose CursorWindow caps a single
// row read at ~2MB. A user with many notes (especially with embedded images)
// blows past that: the write succeeds (~6MB cap) but every read throws
// SQLiteBlobTooBigException, silently yielding an empty list. We persist the
// large collections to plain JSON files instead - files have no row-size limit.

const FILE_DIR = `${FileSystem.documentDirectory}nueco/`;
const FILES = {
  NOTES: `${FILE_DIR}notes.json`,
  EVENTS: `${FILE_DIR}events.json`,
  TRIPS: `${FILE_DIR}trips.json`,
  SYNC_QUEUE: `${FILE_DIR}syncQueue.json`,
};

let _dirReady = false;
async function ensureDir(): Promise<void> {
  if (_dirReady) return;
  const info = await FileSystem.getInfoAsync(FILE_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(FILE_DIR, { intermediates: true });
  }
  _dirReady = true;
}

/** Wipe all locally cached notes/events/sync-queue (used on account deletion). Best-effort. */
export async function clearLocalData(): Promise<void> {
  try {
    await FileSystem.deleteAsync(FILE_DIR, { idempotent: true });
  } catch {
    // ignore - nothing to clear or already gone
  }
  _dirReady = false;
  _notesCache = null;
  _eventsCache = null;
  _tripsCache = null;
  _queueCache = null;
}

// Reads a JSON file, falling back to (and migrating from) a legacy AsyncStorage
// key the first time. If the legacy value is unreadable (e.g. the CursorWindow
// error this fix addresses), we start fresh - fullSync repopulates from server.
async function readJsonFile<T>(uri: string, fallback: T, legacyKey: string): Promise<T> {
  try {
    await ensureDir();
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) {
      try {
        const legacy = await AsyncStorage.getItem(legacyKey);
        if (legacy) {
          await FileSystem.writeAsStringAsync(uri, legacy);
          await AsyncStorage.removeItem(legacyKey);
          return JSON.parse(legacy) as T;
        }
      } catch {
        // Legacy value too big to read - drop it and start from the file store.
        await AsyncStorage.removeItem(legacyKey).catch(() => {});
      }
      return fallback;
    }
    const raw = await FileSystem.readAsStringAsync(uri);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch (e) {
    console.warn('readJsonFile failed for', uri, e);
    return fallback;
  }
}

async function writeJsonFile(uri: string, data: unknown): Promise<void> {
  await ensureDir();
  await FileSystem.writeAsStringAsync(uri, JSON.stringify(data));
}

// ---- Helpers ----

function newerTimestamp(a: string, b: string): string {
  return new Date(a) >= new Date(b) ? a : b;
}

export function isNewer(incoming: string, existing: string): boolean {
  return new Date(incoming) > new Date(existing);
}

// ---- Local Storage ----

// In-memory mirror of the on-disk notes/events files. A single focus-triggered sync (Notes or
// Events tab) reads the full local collection 2-3x (once for the instant local-first render,
// again inside fullSync's merge, again after fullSync to reflect the result) - each read is a
// synchronous JSON.parse of the whole file, which was blocking the JS thread long enough to jank
// tab switches and modal opens (see the crypto decrypt-loop yielding fix, which addressed a
// smaller contributor to the same symptom but not this one). Cached reads return a shallow copy
// (never the live array) so callers that mutate what they get back - several do, in place, before
// saving - can't corrupt the cache or leak a mutation across concurrent callers. Invalidated by
// every write, and by clearLocalData on account deletion so a stale cache can't leak a previous
// account's notes.
let _notesCache: LocalNote[] | null = null;
let _eventsCache: LocalEvent[] | null = null;
let _tripsCache: LocalTrip[] | null = null;

// getLocalNotes()/saveLocalNotes() is a read-whole-array, mutate, write-whole-array-back
// pattern - not atomic across the gap between the read and the write. Three call sites do this
// for `notes` on completely uncoordinated schedules: the editor's own upsertLocalNote (every
// autosave/image add), processSyncQueue's own id-swap-after-create write, and fullSync's
// periodic reconciliation write. If two of these interleave - concretely: the editor adds an
// image while a backgrounded processSyncQueue or fullSync from an earlier save is still
// mid-flight (handleBack fires processSyncQueue() without awaiting it before navigating away) -
// whichever finishes last wins with whatever it read at ITS start, silently discarding the
// other's change. This queue forces every read-modify-write cycle against `notes` to run to
// completion, in order, regardless of which of the three call sites started it - that's the fix
// for "an image quietly disappears after adding a second/third one and navigating back and forth".
//
// Not reentrant: a function running inside withNotesLock must never call another function that
// also takes withNotesLock, or it deadlocks waiting for itself.
function createMutex() {
  let tail: Promise<void> = Promise.resolve();
  return function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = tail.then(fn, fn);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

const withNotesLock = createMutex();

// processNoteOperation's 'create' case (below) swaps a note's local temp id for its real
// server id once the first push lands - but a caller that captured the temp id once (most
// concretely: editor.tsx's noteIdRef, set only when createNoteOffline first resolves, never
// re-read afterward) has no way to know that happened. That swap can happen mid-editing-session:
// handleBack fires processSyncQueue() without awaiting it before navigating away, and
// startBackgroundSync's NetInfo listener (offlineSync.ts, started once when the notes-list
// screen mounts and never torn down while an editor screen is pushed on top of it) can also
// fire processSyncQueue() on any connectivity state event, not just a real reconnect. Every
// updateNoteOffline call after that point looks up the note by the now-stale temp id, finds
// nothing, and silently returns - no error, no throw, "All changes saved" still shows, but
// nothing was ever enqueued to sync. This alias map lets updateNoteOffline/deleteNoteOffline
// transparently resolve a stale id to its current one instead of silently no-op'ing.
const _noteIdAliases = new Map<string, string>();
function resolveNoteId(id: string): string {
  return _noteIdAliases.get(id) || id;
}

export async function getLocalNotes(): Promise<LocalNote[]> {
  if (_notesCache) return [..._notesCache];
  const notes = await readJsonFile<LocalNote[]>(FILES.NOTES, [], KEYS.NOTES);
  _notesCache = notes;
  return [...notes];
}

export async function saveLocalNotes(notes: LocalNote[]): Promise<void> {
  _notesCache = [...notes];
  await writeJsonFile(FILES.NOTES, notes);
}

export async function getLocalEvents(): Promise<LocalEvent[]> {
  if (_eventsCache) return [..._eventsCache];
  const events = await readJsonFile<LocalEvent[]>(FILES.EVENTS, [], KEYS.EVENTS);
  _eventsCache = events;
  return [...events];
}

export async function saveLocalEvents(events: LocalEvent[]): Promise<void> {
  _eventsCache = [...events];
  await writeJsonFile(FILES.EVENTS, events);
}

export async function getLocalTrips(): Promise<LocalTrip[]> {
  if (_tripsCache) return [..._tripsCache];
  const trips = await readJsonFile<LocalTrip[]>(FILES.TRIPS, [], KEYS.TRIPS);
  _tripsCache = trips;
  return [...trips];
}

export async function saveLocalTrips(trips: LocalTrip[]): Promise<void> {
  _tripsCache = [...trips];
  await writeJsonFile(FILES.TRIPS, trips);
}

// ---- Sync Queue ----

// Same in-memory mirror the notes/events/trips collections get above, and for a sharper version
// of the same reason. A queued note create/update carries the note's FULL payload - including a
// body with inline base64 images - so the queue file is as big as the notes file, and every
// single write went through it twice: enqueueOperation reads the whole thing (JSON.parse) to
// merge, then writes the whole thing back (JSON.stringify). That is on the interaction path for
// every note save, every autosave, every link, every pin toggle. Cached reads hand back a
// shallow copy (never the live array) because callers splice/filter/push what they get.
let _queueCache: SyncQueueItem[] | null = null;

export async function getSyncQueue(): Promise<SyncQueueItem[]> {
  if (_queueCache) return [..._queueCache];
  const queue = await readJsonFile<SyncQueueItem[]>(FILES.SYNC_QUEUE, [], KEYS.SYNC_QUEUE);
  _queueCache = queue;
  return [...queue];
}

export async function saveSyncQueue(queue: SyncQueueItem[]): Promise<void> {
  _queueCache = [...queue];
  await writeJsonFile(FILES.SYNC_QUEUE, queue);
}

export async function enqueueOperation(item: Omit<SyncQueueItem, 'retries'>): Promise<void> {
  const queue = await getSyncQueue();

  // If there's already a pending create for this id, just update its payload
  const existingIndex = queue.findIndex(
    q => q.id === item.id && q.entity === item.entity
  );

  if (existingIndex >= 0) {
    const existing = queue[existingIndex];
    // If we're deleting something that was never synced, just remove from queue entirely
    if (item.operation === 'delete' && existing.operation === 'create') {
      queue.splice(existingIndex, 1);
    } else {
      // Merge - keep the earlier operation type but update payload
      queue[existingIndex] = {
        ...existing,
        operation: item.operation === 'delete' ? 'delete' : existing.operation,
        payload: item.payload,
        timestamp: item.timestamp,
      };
    }
  } else {
    queue.push({ ...item, retries: 0 });
  }

  await saveSyncQueue(queue);
}

// ---- Note Operations (Offline-aware) ----

export async function upsertLocalNote(note: LocalNote): Promise<void> {
  return withNotesLock(async () => {
    const notes = await getLocalNotes();
    const idx = notes.findIndex(n => n.id === note.id);
    if (idx >= 0) {
      // Conflict resolution: keep whichever is newer
      if (isNewer(note.updated_at, notes[idx].updated_at)) {
        notes[idx] = note;
      }
    } else {
      notes.push(note);
    }
    await saveLocalNotes(notes);
  });
}

export async function deleteLocalNote(id: string): Promise<void> {
  const notes = await getLocalNotes();
  await saveLocalNotes(notes.filter(n => n.id !== id));
}

// ---- Offline-first note create/update (shared by useOfflineNotes + the editor) ----
// Local write first, then enqueue and (if online) push. Encryption happens once, at
// the push boundary in processNoteOperation - callers pass plaintext. Returns the
// LocalNote so callers can track its (temp) id until the queue swaps in the server id.

// `push: false` writes locally + enqueues but does NOT sync now. The editor uses this
// during autosave so a mid-session push can't swap a note's temp id for its server id
// out from under `noteIdRef` (which would lose subsequent edits). Deferred ops are
// flushed on editor exit / background sync. Default `true` preserves list-screen behavior.
export async function createNoteOffline(
  data: Omit<LocalNote, 'id' | 'created_at' | 'updated_at' | '_isLocal'>,
  opts: { push?: boolean } = {},
): Promise<LocalNote> {
  const now = new Date().toISOString();
  const tempId = `local_${uuid.v4()}`;
  const note: LocalNote = { ...data, id: tempId, created_at: now, updated_at: now, _isLocal: true };

  await upsertLocalNote(note);
  await enqueueOperation({ id: tempId, entity: 'note', operation: 'create', payload: data, timestamp: now });
  incrementNoteCreatedCount().catch(() => {});

  if (opts.push !== false && (await isOnline())) {
    try {
      await processSyncQueue();
    } catch {
      // Sync failed - note is already saved locally and stays queued.
    }
  }
  return note;
}

export async function updateNoteOffline(
  id: string,
  data: Partial<LocalNote>,
  opts: { push?: boolean } = {},
): Promise<void> {
  const resolvedId = resolveNoteId(id);
  const now = new Date().toISOString();
  const notes = await getLocalNotes();
  const existing = notes.find(n => n.id === resolvedId);
  if (!existing) return;

  const updated: LocalNote = { ...existing, ...data, updated_at: now };
  await upsertLocalNote(updated);

  await enqueueOperation({
    id: resolvedId,
    entity: 'note',
    // A note still local (never synced) stays a pending 'create' - enqueueOperation
    // merges this into its existing create op rather than emitting a doomed 'update'.
    operation: existing._isLocal ? 'create' : 'update',
    payload: { ...data, updated_at: now },
    timestamp: now,
  });

  if (opts.push !== false && (await isOnline())) {
    try {
      await processSyncQueue();
    } catch {
      // Sync failed - update is saved locally and stays queued.
    }
  }
}

// Same local-write-then-enqueue-then-push-if-online shape as deleteEventOffline below -
// notes never got this treatment (editor.tsx's confirmDeleteNote called notesApi.delete
// directly), so deleting a note before its create had synced (still a `local_` id) hit the
// server with an id that doesn't exist there, 404'd, and surfaced as "Failed to delete note.
// Please try again." even though there was nothing wrong - the delete succeeds locally either way.
export async function deleteNoteOffline(id: string, opts: { push?: boolean } = {}): Promise<void> {
  const resolvedId = resolveNoteId(id);
  const notes = await getLocalNotes();
  const existing = notes.find(n => n.id === resolvedId);

  if (existing?._isLocal) {
    // Never synced - remove locally and drop the now-pointless pending create from the queue.
    await deleteLocalNote(resolvedId);
    const queue = await getSyncQueue();
    await saveSyncQueue(queue.filter(q => !(q.id === resolvedId && q.entity === 'note')));
    return;
  }

  // Mark pending-delete locally so it disappears from the UI immediately, even before the
  // server confirms.
  const updated = notes.map(n => (n.id === resolvedId ? { ...n, _pendingDelete: true } : n));
  await saveLocalNotes(updated);

  await enqueueOperation({ id: resolvedId, entity: 'note', operation: 'delete', timestamp: new Date().toISOString() });

  if (opts.push !== false && (await isOnline())) {
    try {
      await processSyncQueue();
    } catch {
      // Sync failed - delete stays queued, will retry via background sync.
    }
    await deleteLocalNote(resolvedId);
  }
}

// ---- Event Operations (Offline-aware) ----

export async function upsertLocalEvent(event: LocalEvent): Promise<void> {
  const events = await getLocalEvents();
  const idx = events.findIndex(e => e.id === event.id);
  if (idx >= 0) {
    // Incoming write wins unless the stored copy is provably newer - now decidable for events
    // because they carry updated_at (recordTimestamp falls back to created_at for events stored
    // before that field existed). Phrased as "unless the existing one is newer" rather than
    // "only if the incoming one is newer" so that two writes landing in the same millisecond
    // still behave the way this function always did: the later call wins.
    if (!isNewer(recordTimestamp(events[idx]), recordTimestamp(event))) {
      events[idx] = event;
    }
  } else {
    events.push(event);
  }
  await saveLocalEvents(events);
}

export async function deleteLocalEvent(id: string): Promise<void> {
  const events = await getLocalEvents();
  await saveLocalEvents(events.filter(e => e.id !== id));
}

// ---- Trip Operations (Offline-aware) ----

export async function upsertLocalTrip(trip: LocalTrip): Promise<void> {
  const trips = await getLocalTrips();
  const idx = trips.findIndex(t => t.id === trip.id);
  if (idx >= 0) {
    trips[idx] = trip;
  } else {
    trips.push(trip);
  }
  await saveLocalTrips(trips);
}

export async function deleteLocalTrip(id: string): Promise<void> {
  const trips = await getLocalTrips();
  await saveLocalTrips(trips.filter(t => t.id !== id));
}

// Local-only patch: merges `local_notification_id` into the stored event without
// enqueueing a sync-queue entry or touching the network - this field is never sent to
// the server (see LocalEvent's comment above). Used by `event-editor.tsx` right after a
// create/update completes, once the event's real (server or temp) id is known.
export async function setLocalEventNotificationId(id: string, notificationId: string | null): Promise<void> {
  const events = await getLocalEvents();
  const idx = events.findIndex(e => e.id === id);
  if (idx < 0) return;
  events[idx] = { ...events[idx], local_notification_id: notificationId };
  await saveLocalEvents(events);
}

// Offline-first event create/update/delete - same shape as the note operations above (local
// write first, then enqueue, then push now if online), so events get the same durable retry
// queue notes already had. `writeToDeviceCalendar()` in event-editor.tsx still runs before these
// - that write is local/native (no network), unaffected by any of this.

export async function createEventOffline(
  data: Omit<LocalEvent, 'id' | 'created_at' | 'updated_at' | '_isLocal'>,
  opts: { push?: boolean } = {},
): Promise<LocalEvent> {
  const now = new Date().toISOString();
  const tempId = `local_${uuid.v4()}`;
  const event: LocalEvent = { ...data, id: tempId, created_at: now, updated_at: now, _isLocal: true };
  // The server takes the client's updated_at when it's sent (see backend/events/schemas.py) -
  // this device's clock is the one the merge compares against, so it has to be the one recorded.
  const payload = { ...data, updated_at: now };

  await upsertLocalEvent(event);
  await enqueueOperation({ id: tempId, entity: 'event', operation: 'create', payload, timestamp: now });

  if (opts.push !== false && (await isOnline())) {
    // Deliberately NOT the generic processSyncQueue() here (unlike createNoteOffline): the
    // caller (event-editor.tsx) needs the real server id back in this same call, to link a note
    // to the event it just created. processSyncQueue() would swap the id in storage but hand
    // the caller back a stale local reference holding the temp id. Do the immediate push
    // directly instead, so success returns the real id synchronously; on failure, the item is
    // already queued above and will retry via the background sync listener.
    try {
      const created = await eventsApi.create(await encryptEventForServer(payload));
      const events = await getLocalEvents();
      const idx = events.findIndex(e => e.id === tempId);
      const resolved: LocalEvent = { ...event, id: created.id, _isLocal: false };
      if (idx >= 0) {
        events[idx] = resolved;
        await saveLocalEvents(events);
      }
      const queue = await getSyncQueue();
      await saveSyncQueue(queue.filter(q => !(q.id === tempId && q.entity === 'event')));
      return resolved;
    } catch {
      // Immediate push failed - stays queued (enqueued above), will retry on reconnect.
    }
  }
  return event;
}

export async function updateEventOffline(
  id: string,
  data: Partial<LocalEvent>,
  opts: { push?: boolean } = {},
): Promise<void> {
  const now = new Date().toISOString();
  const events = await getLocalEvents();
  const existing = events.find(e => e.id === id);
  if (!existing) return;

  // Stamped after the spread so it wins even if a caller passed an updated_at of its own: the
  // moment of THIS write is what the merge needs to compare, not whatever the caller was holding.
  const updated: LocalEvent = { ...existing, ...data, updated_at: now };
  await upsertLocalEvent(updated);

  await enqueueOperation({
    id,
    entity: 'event',
    // An event still local (never synced) stays a pending 'create' - enqueueOperation merges
    // this into its existing create op rather than emitting a doomed 'update'.
    operation: existing._isLocal ? 'create' : 'update',
    payload: { ...existing, ...data, updated_at: now },
    timestamp: now,
  });

  if (opts.push !== false && (await isOnline())) {
    try {
      await processSyncQueue();
    } catch {
      // Sync failed - update is saved locally and stays queued.
    }
  }
}

export async function deleteEventOffline(id: string, opts: { push?: boolean } = {}): Promise<void> {
  const events = await getLocalEvents();
  const existing = events.find(e => e.id === id);

  if (existing?._isLocal) {
    // Never synced - remove locally and drop the now-pointless pending create from the queue.
    await deleteLocalEvent(id);
    const queue = await getSyncQueue();
    await saveSyncQueue(queue.filter(q => !(q.id === id && q.entity === 'event')));
    return;
  }

  // Mark pending-delete locally so it disappears from the UI immediately, even before the
  // server confirms.
  const updated = events.map(e => (e.id === id ? { ...e, _pendingDelete: true } : e));
  await saveLocalEvents(updated);

  await enqueueOperation({ id, entity: 'event', operation: 'delete', timestamp: new Date().toISOString() });

  if (opts.push !== false && (await isOnline())) {
    try {
      await processSyncQueue();
    } catch {
      // Sync failed - delete stays queued, will retry via background sync.
    }
    await deleteLocalEvent(id);
  }
}

// Offline-first trip create/update/delete - same local-write-then-enqueue-then-push-if-online
// shape as notes/events above. Unlike createEventOffline, no caller needs the real server id
// back synchronously (nothing links to a brand-new trip in the same action the way a note links
// to a newly-created event), so this uses the simpler processSyncQueue()-based push createNoteOffline
// uses rather than createEventOffline's inline immediate-push special case.

export async function createTripOffline(
  data: Omit<LocalTrip, 'id' | 'created_at' | '_isLocal'>,
  opts: { push?: boolean } = {},
): Promise<LocalTrip> {
  const now = new Date().toISOString();
  const tempId = `local_${uuid.v4()}`;
  const trip: LocalTrip = { ...data, id: tempId, created_at: now, _isLocal: true };

  await upsertLocalTrip(trip);
  await enqueueOperation({ id: tempId, entity: 'trip', operation: 'create', payload: data, timestamp: now });

  if (opts.push !== false && (await isOnline())) {
    try {
      await processSyncQueue();
    } catch {
      // Sync failed - trip is already saved locally and stays queued.
    }
  }
  return trip;
}

export async function updateTripOffline(
  id: string,
  data: Partial<LocalTrip>,
  opts: { push?: boolean } = {},
): Promise<void> {
  const now = new Date().toISOString();
  const trips = await getLocalTrips();
  const existing = trips.find(t => t.id === id);
  if (!existing) return;

  const updated: LocalTrip = { ...existing, ...data };
  await upsertLocalTrip(updated);

  await enqueueOperation({
    id,
    entity: 'trip',
    operation: existing._isLocal ? 'create' : 'update',
    payload: { ...existing, ...data },
    timestamp: now,
  });

  if (opts.push !== false && (await isOnline())) {
    try {
      await processSyncQueue();
    } catch {
      // Sync failed - update is saved locally and stays queued.
    }
  }
}

export async function deleteTripOffline(id: string, opts: { push?: boolean } = {}): Promise<void> {
  const trips = await getLocalTrips();
  const existing = trips.find(t => t.id === id);

  if (existing?._isLocal) {
    await deleteLocalTrip(id);
    const queue = await getSyncQueue();
    await saveSyncQueue(queue.filter(q => !(q.id === id && q.entity === 'trip')));
    return;
  }

  const updated = trips.map(t => (t.id === id ? { ...t, _pendingDelete: true } : t));
  await saveLocalTrips(updated);

  await enqueueOperation({ id, entity: 'trip', operation: 'delete', timestamp: new Date().toISOString() });

  if (opts.push !== false && (await isOnline())) {
    try {
      await processSyncQueue();
    } catch {
      // Sync failed - delete stays queued, will retry via background sync.
    }
    await deleteLocalTrip(id);
  }
}

// ---- Sync Engine ----

let _isSyncing = false;
let _isFullSyncing = false;
let _lastFullSyncAt = 0;
// Every note/event CRUD already updates local state instantly; fullSync's job is reconciling
// with the server, which doesn't need to happen nearly as often as it was being called - every
// tab focus and every back-navigation each triggered their own full fullSync (2 network requests
// + decrypting every note/event), competing with the screen transition for the JS thread. This
// keeps focus-triggered resyncs from re-firing within a few seconds of each other while still
// letting deliberate callers (post-login, app-foreground-resume, pull-to-refresh) force a real one.
const FULL_SYNC_THROTTLE_MS = 20_000;

export async function processSyncQueue(): Promise<void> {
  if (_isSyncing) {
    console.warn('processSyncQueue already running, skipping');
    return;
  }
  _isSyncing = true;

  try {
    const queue = await getSyncQueue();
    if (queue.length === 0) return;

    const failed: SyncQueueItem[] = [];

    for (const item of queue) {
      try {
        if (item.entity === 'note') {
          await processNoteOperation(item);
        } else if (item.entity === 'event') {
          await processEventOperation(item);
        } else if (item.entity === 'trip') {
          await processTripOperation(item);
        }
      } catch (e) {
        console.warn(`Sync failed for ${item.entity} ${item.id}:`, e);
        // Keep in queue with incremented retry count, max 5 retries
        if (item.retries < 5) {
          failed.push({ ...item, retries: item.retries + 1 });
        } else {
          console.error(`Dropping sync item after 5 retries:`, item);
        }
      }
    }

    await saveSyncQueue(failed);
    await AsyncStorage.setItem(KEYS.LAST_SYNC, new Date().toISOString());
  } finally {
    _isSyncing = false;
  }
}

async function processNoteOperation(item: SyncQueueItem): Promise<void> {
  switch (item.operation) {
    case 'create': {
      // Encrypt outbound fields (no-op when E2EE is off / no DEK). The local copy
      // keeps its plaintext fields; we only adopt the server-assigned id below.
      const created = await notesApi.create(await encryptNoteForServer(item.payload));
      // Update local storage: replace temp ID with server ID
      await withNotesLock(async () => {
        const notes = await getLocalNotes();
        const idx = notes.findIndex(n => n.id === item.id);
        if (idx >= 0) {
          notes[idx] = { ...notes[idx], id: created.id, _isLocal: false };
          await saveLocalNotes(notes);
          _noteIdAliases.set(item.id, created.id);
        }
      });
      break;
    }
    case 'update': {
      const encrypted = await encryptNoteForServer(item.payload);
      // Check server version for conflict resolution. updated_at is never encrypted,
      // so the timestamp comparison works on the ciphertext note as-is.
      try {
        const serverNote = await notesApi.get(item.id);
        if (isNewer(item.payload.updated_at, serverNote.updated_at)) {
          await notesApi.update(item.id, encrypted);
        } else {
          // Server is newer - decrypt then store as the local plaintext copy.
          await upsertLocalNote({ ...(await decryptNoteFromServer(serverNote)), _isLocal: false });
        }
      } catch {
        await notesApi.update(item.id, encrypted);
      }
      break;
    }
    case 'delete': {
      await notesApi.delete(item.id);
      break;
    }
  }
}

async function processEventOperation(item: SyncQueueItem): Promise<void> {
  switch (item.operation) {
    case 'create': {
      const created = await eventsApi.create(await encryptEventForServer(item.payload));
      const events = await getLocalEvents();
      const idx = events.findIndex(e => e.id === item.id);
      if (idx >= 0) {
        events[idx] = { ...events[idx], id: created.id, _isLocal: false };
        await saveLocalEvents(events);
      }
      break;
    }
    case 'update': {
      await eventsApi.update(item.id, await encryptEventForServer(item.payload));
      break;
    }
    case 'delete': {
      await eventsApi.delete(item.id);
      break;
    }
  }
}

async function processTripOperation(item: SyncQueueItem): Promise<void> {
  switch (item.operation) {
    case 'create': {
      const created = await tripsApi.create(await encryptTripForServer(item.payload));
      const trips = await getLocalTrips();
      const idx = trips.findIndex(t => t.id === item.id);
      if (idx >= 0) {
        trips[idx] = { ...trips[idx], id: created.id, _isLocal: false };
        await saveLocalTrips(trips);
      }
      break;
    }
    case 'update': {
      await tripsApi.update(item.id, await encryptTripForServer(item.payload));
      break;
    }
    case 'delete': {
      await tripsApi.delete(item.id);
      break;
    }
  }
}

// ---- Full Sync (pull from server + merge local) ----

export async function fullSync(opts: { force?: boolean } = {}): Promise<void> {
  if (_isFullSyncing) return;
  if (!opts.force && Date.now() - _lastFullSyncAt < FULL_SYNC_THROTTLE_MS) return;
  _isFullSyncing = true;
  try {
    // 1. Push pending local changes first
    await processSyncQueue();

    // 2. Pull latest from server - notes, events and trips are independent; don't let
    //    a broken response for one block the others from being saved.
    //
    //    Every pull pages to the end of its collection and reports whether it got there
    //    (PagedPull.complete). That flag is what the merges below need: these endpoints are
    //    paginated, and reading only the first page while assuming it was the whole collection is
    //    what silently deleted every note past the first 50 from the device on each sync.
    //
    //    Captured before the pulls, not after: any local write with a later timestamp than this
    //    happened while the pull was in flight, so the pull cannot be treated as knowing about it.
    const pullStartedAt = new Date().toISOString();
    const [notesResult, eventsResult, tripsResult] = await Promise.allSettled([
      notesApi.getAllPaged(),
      eventsApi.getAllPaged(),
      tripsApi.getAllPaged(),
    ]);

    // 3. Merge server notes with local (newest write wins - see syncMergeCore)
    if (notesResult.status === 'fulfilled') {
      const notesPull = notesResult.value;
      // Decrypt server notes to plaintext before they enter the (plaintext) local store.
      const serverNotes = await decryptNotesFromServer(notesPull.items);
      const mergedNotes = await withNotesLock(async () => {
        const merged = mergeRecords<LocalNote>({
          server: serverNotes as LocalNote[],
          local: await getLocalNotes(),
          serverPullComplete: notesPull.complete,
          pullStartedAt,
        });
        await saveLocalNotes(merged);
        return merged;
      });
      if (!notesPull.complete) {
        console.warn('fullSync: notes pull was incomplete - keeping local notes it did not cover');
      }
      console.log('fullSync saved notes count:', mergedNotes.length);
    } else {
      console.warn('fullSync: notes fetch failed:', notesResult.reason);
    }

    // 4. Merge server events (independently - a failure here won't lose notes)
    if (eventsResult.status === 'fulfilled') {
      const eventsPull = eventsResult.value;
      const decryptedEvents = await decryptEventsFromServer(eventsPull.items);
      const mergedEvents = mergeRecords<LocalEvent>({
        server: decryptedEvents as LocalEvent[],
        local: await getLocalEvents(),
        serverPullComplete: eventsPull.complete,
        pullStartedAt,
        // `local_notification_id` is device-local-only and never round-trips through the server -
        // without carrying it over from the previous local copy, this fullSync would silently wipe
        // it and orphan the still-scheduled OS notification (nothing would be able to find its id
        // to cancel/reschedule it again).
        adoptLocalFields: (serverEvent, previousLocal) => ({
          ...serverEvent,
          local_notification_id: previousLocal?.local_notification_id ?? null,
        }),
      });
      if (!eventsPull.complete) {
        console.warn('fullSync: events pull was incomplete - keeping local events it did not cover');
      }
      await saveLocalEvents(mergedEvents);
    } else {
      console.warn('fullSync: events fetch failed:', eventsResult.reason);
    }

    // 5. Merge server trips (independently - a failure here won't lose notes/events)
    if (tripsResult.status === 'fulfilled') {
      const tripsPull = tripsResult.value;
      const decryptedTrips = await decryptTripsFromServer(tripsPull.items);
      const mergedTrips = mergeRecords<LocalTrip>({
        server: decryptedTrips as LocalTrip[],
        local: await getLocalTrips(),
        serverPullComplete: tripsPull.complete,
        pullStartedAt,
      });
      if (!tripsPull.complete) {
        console.warn('fullSync: trips pull was incomplete - keeping local trips it did not cover');
      }
      await saveLocalTrips(mergedTrips);
    } else {
      console.warn('fullSync: trips fetch failed:', tripsResult.reason);
    }

  } catch (e) {
    console.warn('Full sync failed:', e);
  } finally {
    _isFullSyncing = false;
    _lastFullSyncAt = Date.now();
  }
}

// ---- Network Listener (Background Sync) ----

let _unsubscribeNetInfo: (() => void) | null = null;

export function startBackgroundSync(): void {
  if (_unsubscribeNetInfo) return; // already started

  _unsubscribeNetInfo = NetInfo.addEventListener(async (state: NetInfoState) => {
    if (state.isConnected && state.isInternetReachable) {
      console.log('🌐 Back online - starting background sync...');
      await processSyncQueue();
    }
  });

  console.log('✅ Background sync listener started');
}

export function stopBackgroundSync(): void {
  if (_unsubscribeNetInfo) {
    _unsubscribeNetInfo();
    _unsubscribeNetInfo = null;
  }
}

// ---- Network Status ----

export async function isOnline(): Promise<boolean> {
  const state = await NetInfo.fetch();
  // isInternetReachable can be null on Android while determining connectivity.
  // Only treat as offline when we KNOW internet is unreachable (false), not uncertain (null).
  return !!(state.isConnected && state.isInternetReachable !== false);
}
