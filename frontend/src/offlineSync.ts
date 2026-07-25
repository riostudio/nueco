/**
 * offlineSync.ts
 * MemoPad Offline Sync Manager
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
import { notesApi, eventsApi } from './api';
import { encryptNoteForServer, decryptNoteFromServer, decryptNotesFromServer } from './crypto/noteCrypto';
import { encryptEventForServer, decryptEventsFromServer } from './crypto/eventCrypto';
import { incrementNoteCreatedCount } from './feedbackToast';
import type { Recurrence } from './types';

// ---- Types ----

export type SyncOperation = 'create' | 'update' | 'delete';
export type SyncEntity = 'note' | 'event';

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
  start_time: string;
  end_time: string;
  linked_note_ids: string[];
  reminder_minutes?: number | null;
  device_calendar_event_id?: string | null;
  recurrence?: Recurrence | null;
  timezone?: string | null;
  // Local-only: the id returned by `Notifications.scheduleNotificationAsync` for this
  // event's reminder. Meaningful only on the device that scheduled it - never sent to or
  // read from the server (see `event-editor.tsx`'s `scheduleReminder`/`cancelLocalNotification`,
  // and the `fullSync` merge below, which re-attaches it after a server refresh would
  // otherwise silently drop it since the server never stores/returns this field).
  local_notification_id?: string | null;
  user_id?: string;
  created_at: string;
  _isLocal?: boolean;
  _pendingDelete?: boolean;
}

// ---- Storage Keys ----

const KEYS = {
  NOTES: 'offline:notes',
  EVENTS: 'offline:events',
  SYNC_QUEUE: 'offline:syncQueue',
  LAST_SYNC: 'offline:lastSync',
};

// ---- File-backed JSON store ----
// AsyncStorage on Android is backed by SQLite, whose CursorWindow caps a single
// row read at ~2MB. A user with many notes (especially with embedded images)
// blows past that: the write succeeds (~6MB cap) but every read throws
// SQLiteBlobTooBigException, silently yielding an empty list. We persist the
// large collections to plain JSON files instead - files have no row-size limit.

const FILE_DIR = `${FileSystem.documentDirectory}memopad/`;
const FILES = {
  NOTES: `${FILE_DIR}notes.json`,
  EVENTS: `${FILE_DIR}events.json`,
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

function isNewer(incoming: string, existing: string): boolean {
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

// ---- Sync Queue ----

export async function getSyncQueue(): Promise<SyncQueueItem[]> {
  return readJsonFile<SyncQueueItem[]>(FILES.SYNC_QUEUE, [], KEYS.SYNC_QUEUE);
}

export async function saveSyncQueue(queue: SyncQueueItem[]): Promise<void> {
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
  const now = new Date().toISOString();
  const notes = await getLocalNotes();
  const existing = notes.find(n => n.id === id);
  if (!existing) return;

  const updated: LocalNote = { ...existing, ...data, updated_at: now };
  await upsertLocalNote(updated);

  await enqueueOperation({
    id,
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

// ---- Event Operations (Offline-aware) ----

export async function upsertLocalEvent(event: LocalEvent): Promise<void> {
  const events = await getLocalEvents();
  const idx = events.findIndex(e => e.id === event.id);
  if (idx >= 0) {
    // Events don't have updated_at, use created_at as fallback
    events[idx] = event;
  } else {
    events.push(event);
  }
  await saveLocalEvents(events);
}

export async function deleteLocalEvent(id: string): Promise<void> {
  const events = await getLocalEvents();
  await saveLocalEvents(events.filter(e => e.id !== id));
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
  data: Omit<LocalEvent, 'id' | 'created_at' | '_isLocal'>,
  opts: { push?: boolean } = {},
): Promise<LocalEvent> {
  const now = new Date().toISOString();
  const tempId = `local_${uuid.v4()}`;
  const event: LocalEvent = { ...data, id: tempId, created_at: now, _isLocal: true };

  await upsertLocalEvent(event);
  await enqueueOperation({ id: tempId, entity: 'event', operation: 'create', payload: data, timestamp: now });

  if (opts.push !== false && (await isOnline())) {
    // Deliberately NOT the generic processSyncQueue() here (unlike createNoteOffline): the
    // caller (event-editor.tsx) needs the real server id back in this same call, to link a note
    // to the event it just created. processSyncQueue() would swap the id in storage but hand
    // the caller back a stale local reference holding the temp id. Do the immediate push
    // directly instead, so success returns the real id synchronously; on failure, the item is
    // already queued above and will retry via the background sync listener.
    try {
      const created = await eventsApi.create(await encryptEventForServer(data));
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

  const updated: LocalEvent = { ...existing, ...data };
  await upsertLocalEvent(updated);

  await enqueueOperation({
    id,
    entity: 'event',
    // An event still local (never synced) stays a pending 'create' - enqueueOperation merges
    // this into its existing create op rather than emitting a doomed 'update'.
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
      const notes = await getLocalNotes();
      const idx = notes.findIndex(n => n.id === item.id);
      if (idx >= 0) {
        notes[idx] = { ...notes[idx], id: created.id, _isLocal: false };
        await saveLocalNotes(notes);
      }
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

// ---- Full Sync (pull from server + merge local) ----

export async function fullSync(opts: { force?: boolean } = {}): Promise<void> {
  if (_isFullSyncing) return;
  if (!opts.force && Date.now() - _lastFullSyncAt < FULL_SYNC_THROTTLE_MS) return;
  _isFullSyncing = true;
  try {
    // 1. Push pending local changes first
    await processSyncQueue();

    // 2. Pull latest from server - notes and events are independent; don't let
    //    a broken events response block notes from being saved.
    const [notesResult, eventsResult] = await Promise.allSettled([
      notesApi.getAll(),
      eventsApi.getAll(),
    ]);

    // 3. Merge server notes with local (timestamp wins)
    if (notesResult.status === 'fulfilled') {
      // Decrypt server notes to plaintext before they enter the (plaintext) local store.
      const serverNotes = await decryptNotesFromServer(notesResult.value);
      const localNotes = await getLocalNotes();
      const mergedNotes: LocalNote[] = [...serverNotes.map((n: any) => ({ ...n, _isLocal: false }))];

      for (const local of localNotes) {
        if (local._pendingDelete) continue;
        if (local._isLocal) {
          mergedNotes.push(local);
          continue;
        }
      }

      await saveLocalNotes(mergedNotes);
      console.log('fullSync saved notes count:', mergedNotes.length);
    } else {
      console.warn('fullSync: notes fetch failed:', notesResult.reason);
    }

    // 4. Merge server events (independently - a failure here won't lose notes)
    if (eventsResult.status === 'fulfilled') {
      const decryptedEvents = await decryptEventsFromServer(eventsResult.value);
      const localEvents = await getLocalEvents();
      const localEventsById = new Map(localEvents.map((e) => [e.id, e]));
      const mergedEvents: LocalEvent[] = decryptedEvents.map((e: any) => ({
        ...e,
        _isLocal: false,
        // `local_notification_id` is device-local-only and never round-trips through the
        // server - without carrying it over from the previous local copy, this fullSync
        // would silently wipe it and orphan the still-scheduled OS notification (nothing
        // would be able to find its id to cancel/reschedule it again).
        local_notification_id: localEventsById.get(e.id)?.local_notification_id ?? null,
      }));

      // Same preservation as the notes merge above - without this, an event created/edited
      // offline (still queued, not yet on the server) would get silently wiped the next time
      // fullSync() runs, since the server's response wouldn't include it yet.
      for (const local of localEvents) {
        if (local._pendingDelete) continue;
        if (local._isLocal) {
          mergedEvents.push(local);
          continue;
        }
      }

      await saveLocalEvents(mergedEvents);
    } else {
      console.warn('fullSync: events fetch failed:', eventsResult.reason);
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
