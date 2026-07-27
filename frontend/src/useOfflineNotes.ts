/**
 * useOfflineNotes.ts
 * Offline-aware hook for notes - drop-in replacement for direct notesApi calls
 *
 * Usage:
 *   const { notes, createNote, updateNote, deleteNote, isOnline, isSyncing } = useOfflineNotes();
 */
import { authStorage } from './auth/storage/authStorage';
import { useState, useEffect, useCallback, useRef } from 'react';
import { AppState, AppStateStatus, LayoutAnimation, Platform, UIManager } from 'react-native';
import { useAuth } from './auth/context/AuthContext';

// Old Android bridge needs this opt-in for LayoutAnimation; no-op on iOS/New Architecture.
// Same pattern as DailyBrewCard.tsx's dismiss animation.
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
import {
  getLocalNotes,
  saveLocalNotes,
  getLocalEvents,
  deleteLocalNote,
  enqueueOperation,
  processSyncQueue,
  createNoteOffline,
  updateNoteOffline,
  createEventOffline,
  updateEventOffline,
  deleteEventOffline,
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
  const [syncError, setSyncError] = useState<string | null>(null);
  const appState = useRef(AppState.currentState);
  const { isSyncReady } = useAuth();

  // Load notes from local storage
  const loadNotes = useCallback(async () => {
    const local = await getLocalNotes();
    console.log('loadNotes - local count:', local.length);
    // Animate the list reflow (card sliding in/out, siblings easing into the vacated/new space)
    // instead of an abrupt snap whenever a note is created/deleted - a no-op if this particular
    // update doesn't actually change the list.
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    // Filter out pending deletes for display
    setNotes(local.filter(n => !n._pendingDelete));
  }, []);

  // Sync and reload. Offline-first: show cached notes IMMEDIATELY, then sync in the background and
  // refresh. Previously the full network sync ran before the first loadNotes, so the list (and its
  // blocking spinner) waited on the network - the tab felt slow to open.
  const syncAndReload = useCallback(async (opts: { force?: boolean } = {}) => {
    await loadNotes(); // instant: cached notes on screen right away
    const token = await authStorage.getAccessToken();
    if (!token) return;
    const online = await checkOnline();
    setOnline(online);
    if (!online) return;
    setIsSyncing(true);
    setSyncError(null);
    try {
      await fullSync(opts);
      await loadNotes(); // reflect synced changes
    } catch (e: any) {
      setSyncError(e?.message || 'Sync failed');
    } finally {
      setIsSyncing(false);
    }
  }, [loadNotes]);

  // Re-run syncAndReload when isSyncReady flips to true (post-login fullSync complete)
  // so the hook picks up notes that AuthContext just saved to AsyncStorage.
  useEffect(() => {
    if (isSyncReady) syncAndReload();
  }, [isSyncReady, syncAndReload]);

  useEffect(() => {
    // Initial load for returning users (isSyncReady stays false for them)
    syncAndReload();

    // Start background sync listener
    startBackgroundSync();

    // Sync when app comes to foreground
    const sub = AppState.addEventListener('change', async (nextState: AppStateStatus) => {
      if (
        appState.current.match(/inactive|background/) &&
        nextState === 'active'
      ) {
        // Force: real time has passed while backgrounded, unlike a quick tab-switch/back-nav -
        // worth an actual resync regardless of the throttle.
        await syncAndReload({ force: true });
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
    const note = await createNoteOffline(data);
    await loadNotes();
    return note;
  }, [loadNotes]);

  const updateNote = useCallback(async (id: string, data: Partial<LocalNote>): Promise<void> => {
    // Local-first, network push deferred: updateNoteOffline's default push:true awaited the
    // network round-trip before returning, so loadNotes() (and the pin/edit becoming visible in
    // the list) didn't run until that finished - a tap on Pin visibly did nothing for the whole
    // round-trip, and a second tap inside that window read stale is_pinned state and could flap
    // the toggle back. Same local-write-then-background-flush pattern as editor.tsx's handleBack.
    await updateNoteOffline(id, data, { push: false });
    await loadNotes();
    processSyncQueue().catch(() => {});
  }, [loadNotes]);

  const deleteNote = useCallback(async (id: string): Promise<void> => {
    const notes = await getLocalNotes();
    const existing = notes.find(n => n.id === id);

    if (existing?._isLocal) {
      // Never synced - just remove locally and drop from queue
      await deleteLocalNote(id);
      await loadNotes();
      return;
    }

    // Mark as pending delete locally and reflect that in the list right away - loadNotes()
    // filters out _pendingDelete notes, so the card disappears immediately instead of waiting
    // on the network push below (previously this ran last, so the note visibly lingered in My
    // Notes for the entire round-trip after the user had already confirmed the delete).
    const updated = notes.map(n =>
      n.id === id ? { ...n, _pendingDelete: true } : n
    );
    await saveLocalNotes(updated);
    await loadNotes();

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
      await loadNotes();
    }
  }, [loadNotes]);

  return {
    notes,
    online,
    isSyncing,
    syncError,
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
    await loadEvents(); // instant: cached events on screen right away
    const online = await checkOnline();
    setOnline(online);
    if (!online) return;
    setIsSyncing(true);
    try {
      await processSyncQueue();
      await loadEvents(); // reflect synced changes
    } finally {
      setIsSyncing(false);
    }
  }, [loadEvents]);

  useEffect(() => {
    syncAndReload();
  }, [syncAndReload]);

  // Local-first create/update/delete (temp-id assignment, sync-queue enqueue, immediate push
  // when online) is offlineSync.ts's job - createEventOffline/updateEventOffline/
  // deleteEventOffline, the same functions events.tsx and event-editor.tsx call directly. This
  // hook used to reimplement that logic inline, which had already drifted from the canonical
  // version (missing createEventOffline's synchronous-server-id special case that
  // event-editor.tsx relies on to link a new note to a newly-created event in one action).
  const createEvent = useCallback(async (data: Omit<LocalEvent, 'id' | 'created_at' | '_isLocal'>): Promise<LocalEvent> => {
    const event = await createEventOffline(data);
    await loadEvents();
    return event;
  }, [loadEvents]);

  const updateEvent = useCallback(async (id: string, data: Partial<LocalEvent>): Promise<void> => {
    await updateEventOffline(id, data);
    await loadEvents();
  }, [loadEvents]);

  const deleteEvent = useCallback(async (id: string): Promise<void> => {
    await deleteEventOffline(id);
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