/**
 * useOfflineNotes.ts
 * Offline-aware hook for notes — drop-in replacement for direct notesApi calls
 *
 * Usage:
 *   const { notes, createNote, updateNote, deleteNote, isOnline, isSyncing } = useOfflineNotes();
 */
import { authStorage } from './auth/storage/authStorage';
import { useState, useEffect, useCallback, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import uuid from 'react-native-uuid';
import {
  getLocalNotes,
  saveLocalNotes,
  getLocalEvents,
  saveLocalEvents,
  upsertLocalNote,
  upsertLocalEvent,
  deleteLocalNote,
  deleteLocalEvent,
  enqueueOperation,
  processSyncQueue,
  fullSync,
  startBackgroundSync,
  stopBackgroundSync,
  isOnline as checkOnline,
  LocalNote,
  LocalEvent,
} from './offlineSync';

// ---- useOfflineNotes Hook ----

export function useOfflineNotes() {
  const [notes, setNotes] = useState<LocalNote[]>([]);
  const [online, setOnline] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const appState = useRef(AppState.currentState);

  // Load notes from local storage
  const loadNotes = useCallback(async () => {
    const local = await getLocalNotes();
    console.log('loadNotes — local count:', local.length);
    // Filter out pending deletes for display
    setNotes(local.filter(n => !n._pendingDelete));
  }, []);

  // Sync and reload
  const syncAndReload = useCallback(async () => {
    const token = await authStorage.getAccessToken();
    if (!token) {
      await loadNotes();
      return;
    }
    const online = await checkOnline();
    setOnline(online);
    if (online) {
      setIsSyncing(true);
      try {
        await fullSync();
      } finally {
        setIsSyncing(false);
      }
    }
    await loadNotes();
  }, [loadNotes]);

  useEffect(() => {
    // Initial load
    syncAndReload();

    // Start background sync listener
    startBackgroundSync();

    // Sync when app comes to foreground
    const sub = AppState.addEventListener('change', async (nextState: AppStateStatus) => {
      if (
        appState.current.match(/inactive|background/) &&
        nextState === 'active'
      ) {
        await syncAndReload();
      }
      appState.current = nextState;
    });

    return () => {
      sub.remove();
      stopBackgroundSync();
    };
  }, [syncAndReload]);

  // ---- CRUD ----

  const createNote = useCallback(async (data: Omit<LocalNote, 'id' | 'created_at' | 'updated_at' | '_isLocal'>): Promise<LocalNote> => {
    const now = new Date().toISOString();
    const tempId = `local_${uuid.v4()}`;
    const note: LocalNote = {
      ...data,
      id: tempId,
      created_at: now,
      updated_at: now,
      _isLocal: true,
    };

    // Always save locally first
    await upsertLocalNote(note);

    const online = await checkOnline();
    if (online) {
      // Try to sync immediately
      await enqueueOperation({
        id: tempId,
        entity: 'note',
        operation: 'create',
        payload: data,
        timestamp: now,
      });
      try {
        await processSyncQueue();
      } catch (e) {
        // Sync failed but note is already saved locally
      }
      await loadNotes();
    } else {
      // Queue for later
      await enqueueOperation({
        id: tempId,
        entity: 'note',
        operation: 'create',
        payload: data,
        timestamp: now,
      });
      await loadNotes();
    }

    return note;
  }, [loadNotes]);

  const updateNote = useCallback(async (id: string, data: Partial<LocalNote>): Promise<void> => {
    const now = new Date().toISOString();
    const notes = await getLocalNotes();
    const existing = notes.find(n => n.id === id);
    if (!existing) return;

    const updated: LocalNote = { ...existing, ...data, updated_at: now };
    await upsertLocalNote(updated);
    await loadNotes();

    await enqueueOperation({
      id,
      entity: 'note',
      operation: existing._isLocal ? 'create' : 'update',
      payload: { ...data, updated_at: now },
      timestamp: now,
    });

    const online = await checkOnline();
    if (online) {
      try {
        await processSyncQueue();
      } catch (e) {
        // Sync failed but note is already saved locally
      }
      await loadNotes();
    }
  }, [loadNotes]);

  const deleteNote = useCallback(async (id: string): Promise<void> => {
    const notes = await getLocalNotes();
    const existing = notes.find(n => n.id === id);

    if (existing?._isLocal) {
      // Never synced — just remove locally and drop from queue
      await deleteLocalNote(id);
    } else {
      // Mark as pending delete locally
      const updated = notes.map(n =>
        n.id === id ? { ...n, _pendingDelete: true } : n
      );
      await saveLocalNotes(updated);

      await enqueueOperation({
        id,
        entity: 'note',
        operation: 'delete',
        timestamp: new Date().toISOString(),
      });

      const online = await checkOnline();
      if (online) {
        try {
          await processSyncQueue();
        } catch (e) {
          // Sync failed but delete is queued locally
        }
        await deleteLocalNote(id);
      }
    }

    await loadNotes();
  }, [loadNotes]);

  return {
    notes,
    online,
    isSyncing,
    loadNotes,
    syncAndReload,
    createNote,
    updateNote,
    deleteNote,
  };
}

// ---- useOfflineEvents Hook ----

export function useOfflineEvents() {
  const [events, setEvents] = useState<LocalEvent[]>([]);
  const [online, setOnline] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);

  const loadEvents = useCallback(async () => {
    const local = await getLocalEvents();
    setEvents(local.filter(e => !e._pendingDelete));
  }, []);

  const syncAndReload = useCallback(async () => {
    const online = await checkOnline();
    setOnline(online);
    if (online) {
      setIsSyncing(true);
      try {
        await processSyncQueue();
      } finally {
        setIsSyncing(false);
      }
    }
    await loadEvents();
  }, [loadEvents]);

  useEffect(() => {
    syncAndReload();
  }, [syncAndReload]);

  const createEvent = useCallback(async (data: Omit<LocalEvent, 'id' | 'created_at' | '_isLocal'>): Promise<LocalEvent> => {
    const now = new Date().toISOString();
    const tempId = `local_${uuid.v4()}`;
    const event: LocalEvent = {
      ...data,
      id: tempId,
      created_at: now,
      _isLocal: true,
    };

    // Always save locally first
    await upsertLocalEvent(event);
    await loadEvents();

    await enqueueOperation({
      id: tempId,
      entity: 'event',
      operation: 'create',
      payload: data,
      timestamp: now,
    });

    const online = await checkOnline();
    if (online) {
      try {
        await processSyncQueue();
      } catch (e) {
        // Sync failed but event is already saved locally
      }
      await loadEvents();
    }

    return event;
  }, [loadEvents]);

  const updateEvent = useCallback(async (id: string, data: Partial<LocalEvent>): Promise<void> => {
    const events = await getLocalEvents();
    const existing = events.find(e => e.id === id);
    if (!existing) return;

    const updated: LocalEvent = { ...existing, ...data };
    await upsertLocalEvent(updated);
    await loadEvents();

    await enqueueOperation({
      id,
      entity: 'event',
      operation: existing._isLocal ? 'create' : 'update',
      payload: data,
      timestamp: new Date().toISOString(),
    });

    const online = await checkOnline();
    if (online) {
      try {
        await processSyncQueue();
      } catch (e) {
        // Sync failed but event is already saved locally
      }
      await loadEvents();
    }
  }, [loadEvents]);

  const deleteEvent = useCallback(async (id: string): Promise<void> => {
    const events = await getLocalEvents();
    const existing = events.find(e => e.id === id);

    if (existing?._isLocal) {
      await deleteLocalEvent(id);
    } else {
      const updated = events.map(e =>
        e.id === id ? { ...e, _pendingDelete: true } : e
      );
      await saveLocalEvents(updated);

      await enqueueOperation({
        id,
        entity: 'event',
        operation: 'delete',
        timestamp: new Date().toISOString(),
      });

      const online = await checkOnline();
      if (online) {
        try {
          await processSyncQueue();
        } catch (e) {
          // Sync failed but delete is queued locally
        }
        await deleteLocalEvent(id);
      }
    }

    await loadEvents();
  }, [loadEvents]);

  return {
    events,
    online,
    isSyncing,
    loadEvents,
    syncAndReload,
    createEvent,
    updateEvent,
    deleteEvent,
  };
}