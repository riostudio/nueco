import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  View, Text, Image, StyleSheet, TouchableOpacity, TextInput,
  FlatList, RefreshControl, ActivityIndicator, Modal, Animated, Alert, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import Constants from 'expo-constants';
import * as StoreReview from 'expo-store-review';
import { eventsApi, feedbackApi } from '../../src/api';
import { decryptEventFromServer, decryptEventsFromServer } from '../../src/crypto/eventCrypto';
import { CalendarEvent } from '../../src/types';
import { C, radius, borderWidth } from '../../src/theme';
import { prefixEmoji } from '../../src/events/eventEmoji';
import { ListSkeleton } from '../../src/components/Skeleton';
import { UserAvatar, useAuth } from '../../src/auth';
import { trackNoteSearched, trackNoteDeleted, trackEvent } from '../../src/analytics';
import { useOfflineNotes } from '../../src/useOfflineNotes';
import OfflineBanner from '../../src/components/OfflineBanner';
import FeedbackToast from '../../src/components/FeedbackToast';
import DailyBrewCard from '../../src/components/DailyBrewCard';
import FeedbackCommentModal from '../../src/components/FeedbackCommentModal';
import { getSyncQueue, getLocalNotes, getLocalEvents, LocalNote } from '../../src/offlineSync';
import { parseSourcePost } from '../../src/share/socialSource';
import { plainTextFromContent } from '../../src/textContent';
import { takeNewNoteId } from '../../src/newNoteSignal';
import {
  shouldShowFeedbackToast, markFeedbackToastSeen, getNoteCreatedCount,
  isFeedbackToastRetry, handleFeedbackToastNoAction,
} from '../../src/feedbackToast';

const FEEDBACK_TOAST_DELAY_MS = 4000;

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

// Distinguishes "never edited since creation" from "edited later" in the card's compact
// relative-time footer, without changing formatTime's core relative-time logic. A small
// epsilon absorbs clock/serialization precision noise (e.g. created_at/updated_at differing
// by a few ms/seconds from how the backend or offline queue stamps them) rather than
// requiring an exact string match.
const CREATED_VS_EDITED_EPSILON_MS = 5000;

function formatNoteTimeLabel(createdAt: string, updatedAt: string): string {
  const created = new Date(createdAt).getTime();
  const updated = new Date(updatedAt).getTime();
  const neverEdited = Number.isNaN(created) || Number.isNaN(updated) || Math.abs(updated - created) <= CREATED_VS_EDITED_EPSILON_MS;
  return neverEdited ? `Created ${formatTime(createdAt)}` : `Edited ${formatTime(updatedAt)}`;
}

function stripMd(text: string): string {
  // Notes store rich HTML (+ a shared-post marker); render a clean plain-text preview.
  return plainTextFromContent(text);
}

// Just the fields a note card's linked-event strip renders. Deliberately structural rather than
// `CalendarEvent`, so the locally cached `LocalEvent` (whose `reminder_minutes` is a plain
// `number`) and a freshly-decrypted server `CalendarEvent` can both fill it.
type LinkedEventSummary = {
  id: string;
  title: string;
  start_time: string;
  end_time: string;
  reminder_minutes?: number | null;
};

// Shallow "would any card look different?" comparison for the linked-events map.
function sameEventsMap(
  a: Record<string, LinkedEventSummary>,
  b: Record<string, LinkedEventSummary>,
): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((k) => {
    const x = a[k];
    const y = b[k];
    return (
      !!y &&
      x.title === y.title &&
      x.start_time === y.start_time &&
      x.end_time === y.end_time &&
      (x.reminder_minutes ?? null) === (y.reminder_minutes ?? null)
    );
  });
}

// ---- Card text derivation (memoized) ----
//
// A card's title/preview comes from running the shared-post marker parser AND the full
// HTML -> plain-text pipeline (several whole-string regex passes) over the note's ENTIRE
// `content`. For a note with inline base64 images that string is megabytes, so this is the
// single most expensive thing the list does - and it was being redone for every card on every
// render, including renders triggered by things that have nothing to do with note bodies (the
// linked-events map landing, the newly-created glow animation, the delete modal opening).
//
// The derived text only changes when the note itself changes, so cache it per note version.
// `updated_at` + content length is enough of a version key: every write path stamps updated_at,
// and the length catches the (theoretical) same-millisecond rewrite.
//
// The search haystack is derived here too rather than in the filter, so the ONE run of the
// pipeline serves both. Caching it costs nothing: the expensive input is the base64 image data
// inside `<img>` tags, and the pipeline's output has all tags stripped out of it.
type CardText = { titleText: string; previewText: string; searchText: string; thumbUri: string | null; imageCount: number };

// Pulls the first embedded image out of a note body for the card thumbnail. Derived inside
// cardTextFor's memo rather than at render time on purpose: this scans the same megabyte-scale
// content string the text pipeline does, and doing it per-card-per-render would undo exactly the
// cost the memo was added to remove.
//
// Note the thumbnail can NOT come from `note.attachments` - those bytes are E2EE ciphertext on
// S3 (see src/crypto/attachmentCrypto.ts), so their URLs render as nothing. Only images already
// inline in the note are displayable without fetching and decrypting.
const FIRST_INLINE_IMAGE = /<img\b[^>]*\bsrc="(data:image\/[a-zA-Z0-9.+-]+;base64,[^"]+)"/i;

function thumbnailFor(note: LocalNote, content: string): string | null {
  // `images[]` first: it's already a standalone base64 thumbnail, so no scan of the body needed.
  const gallery = note.images?.find(i => typeof i === 'string' && i.startsWith('data:image'));
  if (gallery) return gallery;
  const inline = FIRST_INLINE_IMAGE.exec(content);
  return inline ? inline[1] : null;
}

// Global twin of FIRST_INLINE_IMAGE, for counting rather than grabbing the first hit. Separate
// object because a /g regex carries lastIndex between calls, and sharing one with the single-match
// lookup above would make each call resume where the previous left off.
const ALL_INLINE_IMAGES = /<img\b[^>]*\bsrc="data:image\//gi;

// Pictures a card should own up to, whether they arrived through "Add image" or the file picker.
// Mirrors thumbnailFor's either/or precedence deliberately: `images[]` and the inline <img> tags
// are two representations of the same pictures depending on which path/app version wrote the note,
// so summing them would double-count a single photo.
function imageCountFor(note: LocalNote, content: string): number {
  const gallery = note.images?.length ?? 0;
  if (gallery > 0) return gallery;
  return content.match(ALL_INLINE_IMAGES)?.length ?? 0;
}

const PREVIEW_CHARS = 120;
// Generous on purpose: what's cached is the tag-stripped text (kilobytes, not the megabytes of
// base64 that made deriving it expensive), and a cap smaller than the library would thrash -
// every search pass would evict the entries the next one needs.
const CARD_TEXT_CACHE_MAX = 1500;
const cardTextCache = new Map<string, CardText>();

function cardTextFor(note: LocalNote): CardText {
  const content = note.content || '';
  const key = `${note.id}|${note.updated_at}|${content.length}|${note.title || ''}`;
  const cached = cardTextCache.get(key);
  if (cached) return cached;

  const src = parseSourcePost(content).sourcePost;
  const body = stripMd(content);
  const derived: CardText = {
    // A shared social post has no title/body of its own - surface its platform + caption so
    // the list entry isn't blank.
    titleText: note.title || src?.title || src?.label || 'Untitled Note',
    previewText: (body || (src ? (src.title ? `${src.label} · ${src.title}` : src.label) : ''))
      .substring(0, PREVIEW_CHARS),
    searchText: body.toLowerCase(),
    thumbUri: thumbnailFor(note, content),
    imageCount: imageCountFor(note, content),
  };

  // Bounded so an unusually large library can't grow this without limit; Map iterates in
  // insertion order, so this drops the oldest entry.
  if (cardTextCache.size >= CARD_TEXT_CACHE_MAX) {
    const oldest = cardTextCache.keys().next().value;
    if (oldest !== undefined) cardTextCache.delete(oldest);
  }
  cardTextCache.set(key, derived);
  return derived;
}

export default function NotesScreen() {
  const router = useRouter();
  const isFocused = useIsFocused();
  const { isSyncReady } = useAuth();
  const { notes, online, isSyncing, syncError, syncAndReload, deleteNote, updateNote } = useOfflineNotes();
  const [pendingCount, setPendingCount] = useState(0);
  const [eventsMap, setEventsMap] = useState<Record<string, LinkedEventSummary>>({});
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

  // "Enjoying Nueco?" feedback toast (fires after the 5th note ever created; if left
  // unanswered, retries once 5 notes later and that retry stays up until dismissed).
  const [showFeedbackToast, setShowFeedbackToast] = useState(false);
  const [isFeedbackRetry, setIsFeedbackRetry] = useState(false);
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

  const loadNotes = useCallback(async (force?: boolean) => {
    try {
      await syncAndReload({ force });
      const queue = await getSyncQueue();
      setPendingCount(queue.length);
      
      // Resolve the events for notes that have linked_event_id.
      // Read fresh notes from the local store - the `notes` closure is stale here
      // because setNotes() was called asynchronously inside syncAndReload().
      const freshNotes = await getLocalNotes();
      const eventIds = freshNotes
        .filter((n) => n.linked_event_id)
        .map((n) => n.linked_event_id as string);

      if (eventIds.length > 0) {
        const wantedIds = new Set(eventIds);
        const uniqueIds = [...wantedIds];

        // Local first. syncAndReload above has just reconciled the local event store with the
        // server, so it already holds these events - this used to go straight to the network on
        // every single call (screen focus, the 30s poll, every pull-to-refresh), which meant a
        // request plus a full list re-render sitting on top of the back-navigation from the
        // editor/event-editor. It also means the linked-event strip on a card still renders
        // offline, where the network path silently left it blank.
        const eventsData: Record<string, LinkedEventSummary> = {};
        const localEvents = await getLocalEvents();
        for (const ev of localEvents) {
          if (!ev._pendingDelete && wantedIds.has(ev.id)) eventsData[ev.id] = ev;
        }

        // Only reach for the network for ids the local store doesn't know about yet.
        const missingIds = uniqueIds.filter((id) => !eventsData[id]);
        if (missingIds.length > 0) {
          // Use batch API to fetch all events in one request (fixes N+1 query)
          try {
            const events = await decryptEventsFromServer<CalendarEvent>(await eventsApi.getBatch(missingIds));
            events.forEach((event: CalendarEvent) => {
              eventsData[event.id] = event;
            });
          } catch (e) {
            console.error('Failed to batch load events:', e);
            // Fallback to individual requests if batch fails
            await Promise.all(
              missingIds.map(async (eventId) => {
                try {
                  const event = await decryptEventFromServer(await eventsApi.get(eventId));
                  eventsData[eventId] = event;
                } catch (err) {
                  console.error('Failed to load event:', eventId, err);
                }
              })
            );
          }
        }

        // Publishing an equivalent-but-new object here re-rendered every card for nothing (and
        // each card re-derives its preview from the note's full HTML body).
        setEventsMap((prev) => (sameEventsMap(prev, eventsData) ? prev : eventsData));
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
          setIsFeedbackRetry(await isFeedbackToastRetry());
          setShowFeedbackToast(true);
          trackEvent('feedback_toast_shown');
        }
      }, FEEDBACK_TOAST_DELAY_MS);

      return () => { if (feedbackTimer.current) clearTimeout(feedbackTimer.current); };
    }, [loadNotes, glowAnim])
  );

  const dismissFeedbackToast = useCallback(() => {
    setShowFeedbackToast(false);
    handleFeedbackToastNoAction().catch(() => {});
    trackEvent('feedback_toast_response', { value: 'dismissed' });
  }, []);

  const handleFeedbackThumbsUp = useCallback(() => {
    setShowFeedbackToast(false);
    markFeedbackToastSeen().catch(() => {});
    trackEvent('feedback_toast_response', { value: 'positive' });
    setTimeout(() => {
      Alert.alert('Would you rate us?', 'A quick rating helps other people find Nueco.', [
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

  // Polling for sync across devices - check for updates every 30 seconds, only while this tab
  // is actually the one visible (see (tabs)/events.tsx for why - all three tabs stay mounted).
  useEffect(() => {
    const pollInterval = setInterval(() => {
      if (!refreshing && !loading && isFocused) {
        loadNotes();
      }
    }, 30000); // 30 seconds

    return () => clearInterval(pollInterval);
  }, [loadNotes, refreshing, loading, isFocused]);

  // Memoized: filtering/splitting the notes array (plus, for a search, running
  // plainTextFromContent over every note's HTML content) reran on every render otherwise -
  // including renders from unrelated state changes (glow animation, modal visibility, feedback
  // toast state) that have nothing to do with the notes list or the search query.
  const filteredNotes = useMemo(
    () =>
      debouncedSearch
        ? notes.filter((n) => {
            const q = debouncedSearch.toLowerCase();
            return (
              n.title?.toLowerCase().includes(q) ||
              // Memoized (see cardTextFor): this used to re-run the whole HTML -> plain-text
              // pipeline over every note's full body - base64 images included - on every
              // debounced keystroke.
              cardTextFor(n).searchText.includes(q) ||
              n.tags?.some((tag) => tag.name?.toLowerCase().includes(q))
            );
          })
        : notes,
    [notes, debouncedSearch]
  );
  const pinnedNotes = useMemo(() => filteredNotes.filter((n) => n.is_pinned), [filteredNotes]);
  const otherNotes = useMemo(() => filteredNotes.filter((n) => !n.is_pinned), [filteredNotes]);

  const handleTogglePin = useCallback(async (noteId: string) => {
    // Goes through the same offline-first path every other write on this screen uses (delete,
    // edit, create) instead of calling notesApi directly - the direct call silently no-op'd
    // while offline (network error swallowed into a console.error, is_pinned never flipped
    // locally, no user-visible feedback at all) since it bypassed the local-first queue entirely.
    const note = notes.find((n) => n.id === noteId);
    if (!note) return;
    try {
      await updateNote(noteId, { is_pinned: !note.is_pinned });
    } catch (e) {
      console.error('Toggle pin failed:', e);
    }
  }, [notes, updateNote]);

  const handleDeletePress = useCallback((noteId: string, noteTitle: string) => {
    setNoteToDelete({ id: noteId, title: noteTitle || 'Untitled Note' });
    setDeleteModalVisible(true);
  }, []);

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

  const renderCard = useCallback((note: LocalNote) => {
    const linkedEvent = note.linked_event_id ? eventsMap[note.linked_event_id] : null;
    const { titleText, previewText, thumbUri, imageCount } = cardTextFor(note);
    // Pictures and files counted together: from the card's point of view they're all just things
    // hanging off the note, and the user doesn't sort them by which picker put them there.
    const attachmentCount = (note.attachments?.length ?? 0) + imageCount;

    const isGlow = note.id === glowNoteId;
    const CardTag: any = isGlow ? AnimatedTouchable : TouchableOpacity;
    const glowStyle = isGlow
      ? { borderColor: glowAnim.interpolate({ inputRange: [0, 1], outputRange: [note.is_pinned ? C.primary : C.border, C.success] }) }
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
              <MaterialIcons name="delete" size={22} color={C.text} />
            </TouchableOpacity>
          </View>
        </View>
        {(previewText || thumbUri) ? (
          <View style={s.cardBody}>
            {previewText ? (
              <Text style={[s.cardPreview, thumbUri && s.cardPreviewWithThumb]} numberOfLines={2}>
                {previewText}
              </Text>
            ) : <View style={{ flex: 1 }} />}
            {thumbUri ? <Image source={{ uri: thumbUri }} style={s.cardThumb} /> : null}
          </View>
        ) : null}
        
        {/* Linked Event Info */}
        {linkedEvent && (
          <View style={s.eventInfo}>
            <View style={s.eventInfoRow}>
              <MaterialIcons name="event" size={16} color={C.secondary} />
              <Text style={s.eventInfoTitle} numberOfLines={1}>{prefixEmoji(linkedEvent.title)}</Text>
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

        {/* Plain text on its own line, sharing the event block's left edge, rather than an icon and
            a bare numeral off in the footer: "3" next to a paperclip asks the reader to decode a
            symbol, and at a glance in the sun it reads as part of the timestamp beside it. */}
        {attachmentCount > 0 && (
          <Text style={s.attachCountText}>
            {attachmentCount} {attachmentCount === 1 ? 'attachment' : 'attachments'}
          </Text>
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
          <View style={s.cardMeta}>
            <Text style={s.timeText}>{formatNoteTimeLabel(note.created_at, note.updated_at)}</Text>
          </View>
        </View>
      </CardTag>
    );
  }, [eventsMap, glowNoteId, glowAnim, router, handleTogglePin, handleDeletePress]);

  // `data` is `otherNotes`, so pinned notes (rendered in the list header) never reach here -
  // they used to be fed in and rendered as `null`, which still cost FlatList a cell + a
  // measurement pass each.
  const renderListItem = useCallback(({ item }: { item: LocalNote }) => renderCard(item), [renderCard]);

  // Only block on a spinner when there's genuinely nothing cached yet; otherwise render the cached
  // notes instantly (offline-first) and let the background sync refresh them.
  if (loading && notes.length === 0) {
    return (
      <SafeAreaView style={s.container} edges={['top']}>
        <View style={s.header}>
          <Text style={s.headerTitle}>Notes</Text>
        </View>
        <ListSkeleton count={4} variant="note" label="Loading your notes" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.container} edges={['top']}>
      <View style={s.header}>
        <Text style={s.headerTitle}>Notes</Text>
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
        data={otherNotes}
        keyExtractor={(item) => item.id}
        // Windowing: a card's text is derived from the note's whole HTML body, so rendering the
        // entire library up front (the default windowSize of 21 screens' worth) is the difference
        // between a handful of cards and hundreds being built during the transition into this tab.
        initialNumToRender={8}
        maxToRenderPerBatch={8}
        updateCellsBatchingPeriod={50}
        windowSize={7}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); loadNotes(true); }}
            colors={[C.primary]}
          />
        }
        ListEmptyComponent={
          // Guarded on `filteredNotes`, not on `data` (= otherNotes): a library where every note
          // is pinned has an empty `data` but is very much not empty on screen.
          filteredNotes.length > 0 ? null : (
            <View style={s.empty}>
              <MaterialIcons name="note-add" size={72} color={C.borderSub} />
              <Text style={s.emptyTitle}>
                {search ? 'Nothing matched that' : 'Nothing here yet'}
              </Text>
              <Text style={s.emptySub}>
                {search
                  ? 'Try another word.'
                  : syncError
                    ? 'Couldn’t reach your notes just now. Nothing’s lost.'
                    : 'Say something and it’ll be waiting.'}
              </Text>
            </View>
          )
        }
        ListHeaderComponent={
          <View>
            <DailyBrewCard />
            {pinnedNotes.length > 0 && (
              <>
                <Text style={s.section}>Pinned</Text>
                {pinnedNotes.map(renderCard)}
                {otherNotes.length > 0 && <Text style={s.section}>All notes</Text>}
              </>
            )}
          </View>
        }
        renderItem={renderListItem}
        ListFooterComponent={<View style={{ height: 100 }} />}
      />

      <TouchableOpacity
        testID="create-note-btn"
        style={s.fab}
        onPress={() => router.push({ pathname: '/editor', params: { noteId: 'new' } })}
        activeOpacity={0.8}
      >
        <MaterialIcons name="add" size={32} color={C.primaryFg} />
        <Text style={s.fabText}>New note</Text>
      </TouchableOpacity>

      <FeedbackToast
        visible={showFeedbackToast}
        onThumbsUp={handleFeedbackThumbsUp}
        onThumbsDown={handleFeedbackThumbsDown}
        onDismiss={dismissFeedbackToast}
        autoDismiss={!isFeedbackRetry}
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
            <Text style={s.modalTitle}>Delete this note?</Text>
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
    backgroundColor: C.surface, borderRadius: radius.md,
    borderWidth: borderWidth.thick, borderColor: C.border,
    paddingHorizontal: 16, height: 56,
  },
  searchInput: { flex: 1, fontSize: 20, color: C.text, marginLeft: 12 },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 24 },
  section: { fontSize: 18, fontWeight: '600', color: C.textSec, marginBottom: 8, marginTop: 4 },
  card: {
    backgroundColor: C.surface, borderRadius: radius.md, padding: 12,
    marginBottom: 10,
    // Border removed by request. Surface (#FFFFFF) and page (#FDFBF7) are close enough that a
    // borderless card would nearly dissolve into the background, so a very soft shadow keeps the
    // edge readable without reintroducing a visible grey line.
    shadowColor: '#0A5443', shadowOpacity: 0.06, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  // Pinned keeps an explicit border: it's the only thing marking a pinned note apart from the
  // tinted background, and the base card no longer supplies a border width for it to recolour.
  pinnedCard: { borderWidth: borderWidth.regular, borderColor: C.primary, backgroundColor: C.surfaceHi },
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
  cardTitle: { fontSize: 18, fontWeight: '700', color: C.text, flex: 1, marginRight: 8 },
  // The gap below lives here rather than on cardPreview: the thumbnail is taller than two lines of
  // preview text, so a margin on the text alone left the image butting straight into the event
  // block. On the row, whichever child is tallest sets the clearance.
  cardBody: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 8 },
  // Beside the preview rather than above it, so a card with an image is the same height as one
  // without and the list keeps an even rhythm.
  cardThumb: { width: 52, height: 52, borderRadius: 8, backgroundColor: C.border },
  cardPreviewWithThumb: { flex: 1 },
  cardMeta: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  attachCountText: { fontSize: 12, color: C.textSec, fontVariant: ['tabular-nums'], marginBottom: 8 },
  cardPreview: { fontSize: 15, color: C.textSec, lineHeight: 20 },
  // Event info in card
  eventInfo: {
    backgroundColor: C.secondaryTint,
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
    borderWidth: borderWidth.regular, marginRight: 6, marginBottom: 2,
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
