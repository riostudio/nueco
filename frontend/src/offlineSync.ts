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
import { notesApi, eventsApi } from './api';
import { encryptNoteForServer, decryptNoteFromServer, decryptNotesFromServer } from './crypto/noteCrypto';

// ---- Types ----

export type SyncOperation = 'create' | 'update' | 'delete';
export type SyncEntity = 'note' | 'event';

export interface SyncQueueItem {
  id: string;               // local temp ID (for creates) or server ID
  serverId?: string;        // set after first successful create
  entity: SyncEntity;
  operation: SyncOperation;
  payload?: any;            // the data to send
  timestamp: string;        // ISO — when queued
  retries: number;
}

export interface LocalNote {
  id: string;
  title: string;
  content: string;
  tags: any[];
  is_pinned: boolean;
  linked_event_id?: string | null;
  images: string[];
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
  start_time: string;
  end_time: string;
  linked_note_ids: string[];
  reminder_minutes?: number | null;
  device_calendar_event_id?: string | null;
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
// large collections to plain JSON files instead — files have no row-size limit.

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

// Reads a JSON file, falling back to (and migrating from) a legacy AsyncStorage
// key the first time. If the legacy value is unreadable (e.g. the CursorWindow
// error this fix addresses), we start fresh — fullSync repopulates from server.
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
        // Legacy value too big to read — drop it and start from the file store.
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

export async function getLocalNotes(): Promise<LocalNote[]> {
  return readJsonFile<LocalNote[]>(FILES.NOTES, [], KEYS.NOTES);
}

export async function saveLocalNotes(notes: LocalNote[]): Promise<void> {
  await writeJsonFile(FILES.NOTES, notes);
}

export async function getLocalEvents(): Promise<LocalEvent[]> {
  return readJsonFile<LocalEvent[]>(FILES.EVENTS, [], KEYS.EVENTS);
}

export async function saveLocalEvents(events: LocalEvent[]): Promise<void> {
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
      // Merge — keep the earlier operation type but update payload
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

// ---- Sync Engine ----

let _isSyncing = false;
let _isFullSyncing = false;

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
          // Server is newer — decrypt then store as the local plaintext copy.
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
      const created = await eventsApi.create(item.payload);
      const events = await getLocalEvents();
      const idx = events.findIndex(e => e.id === item.id);
      if (idx >= 0) {
        events[idx] = { ...events[idx], id: created.id, _isLocal: false };
        await saveLocalEvents(events);
      }
      break;
    }
    case 'update': {
      await eventsApi.update(item.id, item.payload);
      break;
    }
    case 'delete': {
      await eventsApi.delete(item.id);
      break;
    }
  }
}

// ---- Full Sync (pull from server + merge local) ----

export async function fullSync(): Promise<void> {
  if (_isFullSyncing) return;
  _isFullSyncing = true;
  try {
    // 1. Push pending local changes first
    await processSyncQueue();

    // 2. Pull latest from server — notes and events are independent; don't let
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

    // 4. Merge server events (independently — a failure here won't lose notes)
    if (eventsResult.status === 'fulfilled') {
      const mergedEvents: LocalEvent[] = eventsResult.value.map((e: any) => ({ ...e, _isLocal: false }));
      await saveLocalEvents(mergedEvents);
    } else {
      console.warn('fullSync: events fetch failed:', eventsResult.reason);
    }

  } catch (e) {
    console.warn('Full sync failed:', e);
  } finally {
    _isFullSyncing = false;
  }
}

// ---- Network Listener (Background Sync) ----

let _unsubscribeNetInfo: (() => void) | null = null;

export function startBackgroundSync(): void {
  if (_unsubscribeNetInfo) return; // already started

  _unsubscribeNetInfo = NetInfo.addEventListener(async (state: NetInfoState) => {
    if (state.isConnected && state.isInternetReachable) {
      console.log('🌐 Back online — starting background sync...');
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
