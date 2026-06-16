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
import NetInfo, { NetInfoState } from '@react-native-community/netinfo';
import { notesApi, eventsApi } from './api';

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

// ---- Helpers ----

function newerTimestamp(a: string, b: string): string {
  return new Date(a) >= new Date(b) ? a : b;
}

function isNewer(incoming: string, existing: string): boolean {
  return new Date(incoming) > new Date(existing);
}

// ---- Local Storage ----

export async function getLocalNotes(): Promise<LocalNote[]> {
  try {
    const raw = await AsyncStorage.getItem(KEYS.NOTES);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function saveLocalNotes(notes: LocalNote[]): Promise<void> {
  await AsyncStorage.setItem(KEYS.NOTES, JSON.stringify(notes));
}

export async function getLocalEvents(): Promise<LocalEvent[]> {
  try {
    const raw = await AsyncStorage.getItem(KEYS.EVENTS);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function saveLocalEvents(events: LocalEvent[]): Promise<void> {
  await AsyncStorage.setItem(KEYS.EVENTS, JSON.stringify(events));
}

// ---- Sync Queue ----

export async function getSyncQueue(): Promise<SyncQueueItem[]> {
  try {
    const raw = await AsyncStorage.getItem(KEYS.SYNC_QUEUE);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function saveSyncQueue(queue: SyncQueueItem[]): Promise<void> {
  await AsyncStorage.setItem(KEYS.SYNC_QUEUE, JSON.stringify(queue));
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
      const created = await notesApi.create(item.payload);
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
      // Check server version for conflict resolution
      try {
        const serverNote = await notesApi.get(item.id);
        if (isNewer(item.payload.updated_at, serverNote.updated_at)) {
          await notesApi.update(item.id, item.payload);
        } else {
          // Server is newer — update local copy
          await upsertLocalNote({ ...serverNote, _isLocal: false });
        }
      } catch {
        await notesApi.update(item.id, item.payload);
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

    // 2. Pull latest from server
    const [serverNotes, serverEvents] = await Promise.all([
      notesApi.getAll(),
      eventsApi.getAll(),
    ]);

    // 3. Merge server notes with local (timestamp wins)
    const localNotes = await getLocalNotes();
    const mergedNotes: LocalNote[] = [...serverNotes.map((n: any) => ({ ...n, _isLocal: false }))];

    for (const local of localNotes) {
      if (local._pendingDelete) continue; // will be deleted once queue processes
      if (local._isLocal) {
        // Not yet on server — preserve it so it isn't lost before the queue syncs it
        mergedNotes.push(local);
        continue;
      }
      // Server already has this note; server pull above already handled it
    }

    await saveLocalNotes(mergedNotes);
    console.log('fullSync saved notes count:', mergedNotes.length);
    // 4. Merge server events
    const mergedEvents: LocalEvent[] = serverEvents.map((e: any) => ({ ...e, _isLocal: false }));
    await saveLocalEvents(mergedEvents);

  } catch (e) {
    console.warn('Full sync failed (offline?):', e);
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
  return !!(state.isConnected && state.isInternetReachable);
}
