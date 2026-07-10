import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  FlatList, RefreshControl, ActivityIndicator, Modal, Animated, Alert, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import Constants from 'expo-constants';
import * as StoreReview from 'expo-store-review';
import { notesApi, eventsApi, feedbackApi } from '../../src/api';
import { decryptEventFromServer, decryptEventsFromServer } from '../../src/crypto/eventCrypto';
import { CalendarEvent } from '../../src/types';
import { C } from '../../src/theme';
import { UserAvatar, useAuth } from '../../src/auth';
import { trackNoteSearched, trackNoteDeleted, trackEvent } from '../../src/analytics';
import { useOfflineNotes } from '../../src/useOfflineNotes';
import OfflineBanner from '../../src/components/OfflineBanner';
import FeedbackToast from '../../src/components/FeedbackToast';
import FeedbackCommentModal from '../../src/components/FeedbackCommentModal';
import { getSyncQueue, getLocalNotes, LocalNote } from '../../src/offlineSync';
import { parseSourcePost } from '../../src/share/socialSource';
import { plainTextFromContent } from '../../src/textContent';
import { takeNewNoteId } from '../../src/newNoteSignal';
import { shouldShowFeedbackToast, markFeedbackToastSeen, getNoteCreatedCount } from '../../src/feedbackToast';

const FEEDBACK_TOAST_DELAY_MS = 4000;

// Extend C with surfaceHi for this screen
const Colors = { ...C, surfaceHi: '#FFF8E1' };

// A note card that can animate its border (for the one-time "newly created" glow).
const AnimatedTouchable = Animated.createAnimatedComponent(TouchableOpacity);

function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString();
}

function stripMd(text: string): string {
  // Notes store rich HTML (+ a shared-post marker); render a clean plain-text preview.
  return plainTextFromContent(text);
}

export default function NotesScreen() {
  const router = useRouter();
  const { isSyncReady } = useAuth();
  const { notes, online, isSyncing, syncError, syncAndReload, deleteNote } = useOfflineNotes();
  const [pendingCount, setPendingCount] = useState(0);
  const [eventsMap, setEventsMap] = useState<Record<string, CalendarEvent>>({});
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // One-time "newly created" glow: the id of the card to pulse + its animation driver.
  const [glowNoteId, setGlowNoteId] = useState<string | null>(null);
  const glowAnim = useRef(new Animated.Value(0)).current;
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedSearch, setDebouncedSearch] = useState('');
  
  // Delete confirmation modal state
  const [deleteModalVisible, setDeleteModalVisible] = useState(false);
  const [noteToDelete, setNoteToDelete] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  // One-time "Enjoying MemoPad?" feedback toast (fires after the 5th note ever created).
  const [showFeedbackToast, setShowFeedbackToast] = useState(false);
  const [showFeedbackComment, setShowFeedbackComment] = useState(false);
  const [submittingFeedback, setSubmittingFeedback] = useState(false);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);


  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setDebouncedSearch(search);
      // Track search event when user performs a search
      if (search.trim().length > 0) {
        trackNoteSearched(search.length);
      }
    }, 400);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [search]);

  // Helper to format event time compactly
  const formatEventTime = (dateStr: string): string => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  // Format reminder minutes to readable text
  const formatReminderMinutes = (minutes: number | null | undefined): string => {
    if (!minutes) return '';
    if (minutes === 5) return '5 min';
    if (minutes === 15) return '15 min';
    if (minutes === 30) return '30 min';
    if (minutes === 60) return '1 hr';
    if (minutes === 1440) return '1 day';
    return `${minutes} min`;
  };

  const loadNotes = useCallback(async () => {
    try {
      await syncAndReload();
      const queue = await getSyncQueue();
      setPendingCount(queue.length);
      
      // Fetch events for notes that have linked_event_id.
      // Read fresh notes from AsyncStorage - the `notes` closure is stale here
      // because setNotes() was called asynchronously inside syncAndReload().
      const freshNotes = await getLocalNotes();
      const eventIds = freshNotes
        .filter((n) => n.linked_event_id)
        .map((n) => n.linked_event_id as string);
      
      if (eventIds.length > 0) {
        const uniqueIds = [...new Set(eventIds)];
        
        // Use batch API to fetch all events in one request (fixes N+1 query)
        try {
          const events = await decryptEventsFromServer<CalendarEvent>(await eventsApi.getBatch(uniqueIds));
          const eventsData: Record<string, CalendarEvent> = {};
          events.forEach((event: CalendarEvent) => {
            eventsData[event.id] = event;
          });
          setEventsMap(eventsData);
        } catch (e) {
          console.error('Failed to batch load events:', e);
          // Fallback to individual requests if batch fails
          const eventsData: Record<string, CalendarEvent> = {};
          await Promise.all(
            uniqueIds.map(async (eventId) => {
              try {
                const event = await decryptEventFromServer(await eventsApi.get(eventId));
                eventsData[eventId] = event;
              } catch (err) {
                console.error('Failed to load event:', eventId, err);
              }
            })
          );
          setEventsMap(eventsData);
        }
      }
    } catch (e) {
      console.error('Failed to load notes:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [syncAndReload]);

  // Re-load notes when post-login sync completes
  useEffect(() => {
    if (isSyncReady) {
      loadNotes();
    }
  }, [isSyncReady]);

  useFocusEffect(
    useCallback(() => {
      loadNotes();
      // If we just came back from creating a note, glow its card once to confirm it was added.
      const newId = takeNewNoteId();
      if (newId) {
        setGlowNoteId(newId);
        glowAnim.setValue(0);
        Animated.sequence([
          Animated.timing(glowAnim, { toValue: 1, duration: 280, useNativeDriver: false }),
          Animated.delay(450),
          Animated.timing(glowAnim, { toValue: 0, duration: 520, useNativeDriver: false }),
        ]).start(() => setGlowNoteId(null));
      }

      // This screen is the default/first tab, so this focus effect fires both on a cold launch
      // and every time the user returns here (e.g. from the editor) - one hook covers both of the
      // "next app open" / "after a short delay" trigger conditions from the feedback-toast plan.
      // Delayed (not instant) so it never interrupts right after saving a note.
      feedbackTimer.current = setTimeout(async () => {
        if (await shouldShowFeedbackToast()) {
          setShowFeedbackToast(true);
          trackEvent('feedback_toast_shown');
        }
      }, FEEDBACK_TOAST_DELAY_MS);

      return () => { if (feedbackTimer.current) clearTimeout(feedbackTimer.current); };
    }, [loadNotes, glowAnim])
  );

  const dismissFeedbackToast = useCallback(() => {
    setShowFeedbackToast(false);
    markFeedbackToastSeen().catch(() => {});
    trackEvent('feedback_toast_response', { value: 'dismissed' });
  }, []);

  const handleFeedbackThumbsUp = useCallback(() => {
    setShowFeedbackToast(false);
    markFeedbackToastSeen().catch(() => {});
    trackEvent('feedback_toast_response', { value: 'positive' });
    setTimeout(() => {
      Alert.alert('Would you rate us?', 'A quick rating helps other people find MemoPad.', [
        { text: 'Not now', style: 'cancel' },
        {
          text: 'Yes',
          onPress: async () => {
            trackEvent('feedback_toast_store_review_prompted');
            try { await StoreReview.requestReview(); } catch {}
          },
        },
      ]);
    }, 400);
  }, []);

  const handleFeedbackThumbsDown = useCallback(() => {
    setShowFeedbackToast(false);
    markFeedbackToastSeen().catch(() => {});
    trackEvent('feedback_toast_response', { value: 'negative' });
    setShowFeedbackComment(true);
  }, []);

  const submitFeedbackComment = useCallback(async (tag: string | null, text: string) => {
    setSubmittingFeedback(true);
    try {
      const noteCount = await getNoteCreatedCount();
      await feedbackApi.submit({
        sentiment: 'negative',
        tag,
        text,
        note_count_at_submission: noteCount,
        app_version: Constants.expoConfig?.version || 'unknown',
        platform: Platform.OS,
      });
      trackEvent('feedback_toast_negative_reason_submitted', { tag, has_text: !!text });
    } catch (e) {
      console.error('Feedback submit failed:', e);
    } finally {
      setSubmittingFeedback(false);
      setShowFeedbackComment(false);
    }
  }, []);

  // Polling for sync across devices - check for updates every 30 seconds
  useEffect(() => {
    const pollInterval = setInterval(() => {
      // Only poll if not currently refreshing and screen is focused
      if (!refreshing && !loading) {
        loadNotes();
      }
    }, 30000); // 30 seconds

    return () => clearInterval(pollInterval);
  }, [loadNotes, refreshing, loading]);

  const filteredNotes = debouncedSearch
    ? notes.filter((n) => {
        const q = debouncedSearch.toLowerCase();
        return (
          n.title?.toLowerCase().includes(q) ||
          plainTextFromContent(n.content || '').toLowerCase().includes(q) ||
          n.tags?.some((tag) => tag.name?.toLowerCase().includes(q))
        );
      })
    : notes;
  const pinnedNotes = filteredNotes.filter((n) => n.is_pinned);
  const otherNotes = filteredNotes.filter((n) => !n.is_pinned);

  const handleTogglePin = async (noteId: string) => {
    try {
      await notesApi.togglePin(noteId);
      loadNotes();
    } catch (e) {
      console.error('Toggle pin failed:', e);
    }
  };

  const handleDeletePress = (noteId: string, noteTitle: string) => {
    setNoteToDelete({ id: noteId, title: noteTitle || 'Untitled Note' });
    setDeleteModalVisible(true);
  };

  const confirmDelete = async () => {
    if (!noteToDelete) return;
    setDeleting(true);
    try {
      await deleteNote(noteToDelete.id);
      // Track note deletion
      trackNoteDeleted();
      loadNotes();
      setDeleteModalVisible(false);
      setNoteToDelete(null);
    } catch (e) {
      console.error('Delete failed:', e);
    } finally {
      setDeleting(false);
    }
  };

  const cancelDelete = () => {
    setDeleteModalVisible(false);
    setNoteToDelete(null);
  };

  const renderCard = (note: LocalNote) => {
    const linkedEvent = note.linked_event_id ? eventsMap[note.linked_event_id] : null;
    // A shared social post has no title/body of its own - surface its platform + caption so
    // the list entry isn't blank.
    const src = parseSourcePost(note.content || '').sourcePost;
    const body = stripMd(note.content || '');
    const titleText = note.title || src?.title || src?.label || 'Untitled Note';
    const previewText = body || (src ? (src.title ? `${src.label} · ${src.title}` : src.label) : '');

    const isGlow = note.id === glowNoteId;
    const CardTag: any = isGlow ? AnimatedTouchable : TouchableOpacity;
    const glowStyle = isGlow
      ? { borderColor: glowAnim.interpolate({ inputRange: [0, 1], outputRange: [note.is_pinned ? C.primary : C.borderSub, C.success] }) }
      : null;

    return (
      <CardTag
        key={note.id}
        testID={`note-card-${note.id}`}
        style={[s.card, note.is_pinned && s.pinnedCard, glowStyle]}
        onPress={() => router.push({ pathname: '/editor', params: { noteId: note.id } })}
        activeOpacity={0.7}
      >
        <View style={s.cardHead}>
          <Text style={s.cardTitle} numberOfLines={1}>
            {titleText}
          </Text>
          <View style={s.cardActions}>
            <TouchableOpacity
              testID={`pin-toggle-${note.id}`}
              onPress={(e) => {
                e.stopPropagation();
                handleTogglePin(note.id);
              }}
              style={s.actionBtn}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <MaterialIcons
                name="push-pin"
                size={22}
                color={note.is_pinned ? C.primary : C.borderSub}
              />
            </TouchableOpacity>
            <TouchableOpacity
              testID={`delete-note-${note.id}`}
              onPress={(e) => {
                e.stopPropagation();
                handleDeletePress(note.id, titleText);
              }}
              style={s.actionBtn}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <MaterialIcons name="delete" size={22} color={C.error} />
            </TouchableOpacity>
          </View>
        </View>
        {previewText ? (
          <Text style={s.cardPreview} numberOfLines={2}>
            {previewText.substring(0, 120)}
          </Text>
        ) : null}
        
        {/* Linked Event Info */}
        {linkedEvent && (
          <View style={s.eventInfo}>
            <View style={s.eventInfoRow}>
              <MaterialIcons name="event" size={16} color={C.secondary} />
              <Text style={s.eventInfoTitle} numberOfLines={1}>{linkedEvent.title}</Text>
            </View>
            <View style={s.eventInfoRow}>
              <MaterialIcons name="schedule" size={14} color={C.textSec} />
              <Text style={s.eventInfoTime}>
                {formatEventTime(linkedEvent.start_time)} - {formatEventTime(linkedEvent.end_time)}
              </Text>
              {linkedEvent.reminder_minutes ? (
                <>
                  <MaterialIcons name="notifications" size={14} color={C.primary} style={{ marginLeft: 8 }} />
                  <Text style={s.eventInfoReminder}>
                    {formatReminderMinutes(linkedEvent.reminder_minutes)}
                  </Text>
                </>
              ) : null}
            </View>
          </View>
        )}
        
        <View style={s.cardFoot}>
          <View style={s.tagsRow}>
            {note.tags.map((tag, i) => (
              <View
                key={i}
                style={[s.tagChip, { backgroundColor: tag.color + '20', borderColor: tag.color }]}
              >
                <Text style={[s.tagText, { color: tag.color }]}>{tag.name}</Text>
              </View>
            ))}
          </View>
          <Text style={s.timeText}>{formatTime(note.updated_at)}</Text>
        </View>
      </CardTag>
    );
  };

  // Only block on a spinner when there's genuinely nothing cached yet; otherwise render the cached
  // notes instantly (offline-first) and let the background sync refresh them.
  if (loading && notes.length === 0) {
    return (
      <SafeAreaView style={s.container}>
        <View style={s.center}>
          <ActivityIndicator size="large" color={C.primary} />
          <Text style={s.loadText}>Loading notes...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.container} edges={['top']}>
      <View style={s.header}>
        <Text style={s.headerTitle}>My Notes</Text>
        <UserAvatar size={36} />
      </View>

      <OfflineBanner online={online} isSyncing={isSyncing} pendingCount={pendingCount} />
      <View style={s.searchBox}>
        <MaterialIcons name="search" size={24} color={C.textSec} />
        <TextInput
          testID="search-input"
          style={s.searchInput}
          placeholder="Search notes..."
          placeholderTextColor={C.borderSub}
          value={search}
          onChangeText={setSearch}
          returnKeyType="search"
        />
        {search.length > 0 && (
          <TouchableOpacity testID="clear-search-btn" onPress={() => setSearch('')}>
            <MaterialIcons name="close" size={24} color={C.textSec} />
          </TouchableOpacity>
        )}
      </View>

      <FlatList
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        data={filteredNotes}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); loadNotes(); }}
            colors={[C.primary]}
          />
        }
        ListEmptyComponent={
          <View style={s.empty}>
            <MaterialIcons name="note-add" size={72} color={C.borderSub} />
            <Text style={s.emptyTitle}>
              {search ? 'No notes found' : 'No notes yet'}
            </Text>
            <Text style={s.emptySub}>
              {search
                ? 'Try a different search term'
                : syncError
                  ? `Sync error: ${syncError}`
                  : 'Tap the button below to create your first note!'}
            </Text>
          </View>
        }
        ListHeaderComponent={
          pinnedNotes.length > 0 ? (
            <View>
              <Text style={s.section}>Pinned</Text>
              {pinnedNotes.map(renderCard)}
              {otherNotes.length > 0 && <Text style={s.section}>All Notes</Text>}
            </View>
          ) : null
        }
        renderItem={({ item }) => {
          // Skip pinned notes as they're rendered in header
          if (item.is_pinned) return null;
          return renderCard(item);
        }}
        ListFooterComponent={<View style={{ height: 100 }} />}
      />

      <TouchableOpacity
        testID="create-note-btn"
        style={s.fab}
        onPress={() => router.push({ pathname: '/editor', params: { noteId: 'new' } })}
        activeOpacity={0.8}
      >
        <MaterialIcons name="add" size={32} color={C.primaryFg} />
        <Text style={s.fabText}>New Note</Text>
      </TouchableOpacity>

      <FeedbackToast
        visible={showFeedbackToast}
        onThumbsUp={handleFeedbackThumbsUp}
        onThumbsDown={handleFeedbackThumbsDown}
        onDismiss={dismissFeedbackToast}
      />
      <FeedbackCommentModal
        visible={showFeedbackComment}
        submitting={submittingFeedback}
        onSubmit={submitFeedbackComment}
        onSkip={() => setShowFeedbackComment(false)}
      />

      {/* Delete Confirmation Modal */}
      <Modal
        visible={deleteModalVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={cancelDelete}
      >
        <View style={s.modalOverlay}>
          <View style={s.modalContent}>
            <MaterialIcons name="delete" size={48} color={C.error} style={{ marginBottom: 16 }} />
            <Text style={s.modalTitle}>Delete Note?</Text>
            <Text style={s.modalMessage}>
              Are you sure you want to delete "{noteToDelete?.title}"? This action cannot be undone.
            </Text>
            <View style={s.modalButtons}>
              <TouchableOpacity
                style={s.modalCancelBtn}
                onPress={cancelDelete}
                activeOpacity={0.7}
              >
                <Text style={s.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={s.modalDeleteBtn}
                onPress={confirmDelete}
                activeOpacity={0.7}
                disabled={deleting}
              >
                {deleting ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Text style={s.modalDeleteText}>Delete</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadText: { fontSize: 20, color: C.textSec, marginTop: 16 },
  header: { 
    flexDirection: 'row', 
    justifyContent: 'space-between', 
    alignItems: 'center',
    paddingHorizontal: 24, 
    paddingTop: 12, 
    paddingBottom: 8 
  },
  headerTitle: { fontSize: 34, fontWeight: '700', color: C.text, letterSpacing: 0.25 },
  searchBox: {
    flexDirection: 'row', alignItems: 'center',
    marginHorizontal: 24, marginBottom: 16,
    backgroundColor: C.surface, borderRadius: 12,
    borderWidth: 2, borderColor: C.border,
    paddingHorizontal: 16, height: 56,
  },
  searchInput: { flex: 1, fontSize: 20, color: C.text, marginLeft: 12 },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 24 },
  section: { fontSize: 18, fontWeight: '600', color: C.textSec, marginBottom: 8, marginTop: 4 },
  card: {
    backgroundColor: C.surface, borderRadius: 10, padding: 12,
    borderWidth: 2, borderColor: C.borderSub, marginBottom: 10,
  },
  pinnedCard: { borderColor: C.primary, backgroundColor: Colors.surfaceHi },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  cardActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  actionBtn: {
    width: 36, height: 36, borderRadius: 18,
    justifyContent: 'center', alignItems: 'center',
    backgroundColor: C.bg,
  },
  cardTitle: { fontSize: 18, fontWeight: '600', color: C.text, flex: 1, marginRight: 8 },
  cardPreview: { fontSize: 15, color: C.textSec, lineHeight: 20, marginBottom: 8 },
  // Event info in card
  eventInfo: {
    backgroundColor: '#E3F2FD',
    padding: 8,
    borderRadius: 8,
    marginBottom: 8,
  },
  eventInfoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
  },
  eventInfoTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: C.secondary,
    marginLeft: 6,
    flex: 1,
  },
  eventInfoTime: {
    fontSize: 12,
    color: C.textSec,
    marginLeft: 4,
  },
  eventInfoReminder: {
    fontSize: 12,
    color: C.primary,
    fontWeight: '500',
    marginLeft: 4,
  },
  cardFoot: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  tagsRow: { flexDirection: 'row', flexWrap: 'wrap', flex: 1 },
  tagChip: {
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6,
    borderWidth: 1.5, marginRight: 6, marginBottom: 2,
  },
  tagText: { fontSize: 12, fontWeight: '600' },
  timeText: { fontSize: 14, color: C.borderSub },
  empty: { alignItems: 'center', paddingTop: 80 },
  emptyTitle: { fontSize: 24, fontWeight: '600', color: C.text, marginTop: 16 },
  emptySub: { fontSize: 18, color: C.textSec, marginTop: 8, textAlign: 'center', paddingHorizontal: 32 },
  fab: {
    position: 'absolute', bottom: 24, right: 24,
    backgroundColor: C.primary, borderRadius: 36,
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 24, height: 64,
    elevation: 4,
  },
  fabText: { fontSize: 20, fontWeight: '600', color: C.primaryFg, marginLeft: 8 },
  // Modal styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalContent: {
    backgroundColor: C.surface,
    borderRadius: 20,
    padding: 24,
    width: '100%',
    maxWidth: 340,
    alignItems: 'center',
  },
  modalTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: C.text,
    marginBottom: 12,
  },
  modalMessage: {
    fontSize: 16,
    color: C.textSec,
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 24,
  },
  modalButtons: {
    flexDirection: 'row',
    gap: 12,
    width: '100%',
  },
  modalCancelBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: '#E0E0E0',
    alignItems: 'center',
  },
  modalCancelText: {
    fontSize: 16,
    fontWeight: '600',
    color: C.text,
  },
  modalDeleteBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: C.error,
    alignItems: 'center',
  },
  modalDeleteText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
});
