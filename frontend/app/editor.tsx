import React, { useState, useEffect, useRef, useCallback, useMemo, forwardRef, useImperativeHandle } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  ScrollView, KeyboardAvoidingView, Platform, Alert, ActivityIndicator,
  Keyboard, Share, Modal, Image,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { useAudioRecorder, AudioModule, RecordingPresets, setAudioModeAsync } from 'expo-audio';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as WebBrowser from 'expo-web-browser';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { notesApi, eventsApi, transcribeApi, textProcessApi, attachmentsApi, uploadAttachmentWithProgress, type UploadFile } from '../src/api';
import { decryptEventFromServer, decryptEventsFromServer } from '../src/crypto/eventCrypto';
import { RadialProgress, SharedPostCard, Button } from '../src/components';
import { decryptNoteFromServer } from '../src/crypto/noteCrypto';
import { createNoteOffline, updateNoteOffline, getLocalNotes, processSyncQueue } from '../src/offlineSync';
import { takePendingShareDraft } from '../src/share/pendingShareDraft';
import { parseSourcePost, serializeSourcePost, type SourcePost } from '../src/share/socialSource';
import { unfurl, needsUnfurl } from '../src/share/unfurl';
import { plainTextFromContent } from '../src/textContent';
import { RichText, useEditorBridge, useEditorContent, useBridgeState } from '@10play/tentap-editor';
import { Tag, CalendarEvent, Attachment } from '../src/types';
import { TAG_COLORS, C, radius } from '../src/theme';
import { setNewNoteId } from '../src/newNoteSignal';
import { 
  authStorage, 
  useAuth,
  UserAvatar,
} from '../src/auth';
import {
  trackNoteCreated,
  trackNoteEdited,
  trackNoteDeleted,
  trackNoteEventScheduled,
  trackNoteImageAttached,
  trackNoteShared,
  trackVoiceRecordingStarted,
  trackVoiceRecordingCompleted,
  trackVoiceRecordingCancelled,
  trackVoiceTranscriptionInserted,
} from '../src/analytics';

// Extension → MIME, aligned with the backend's attachment allowlist. Used to recover a usable
// content type when the picker reports none (Android cloud/content URIs often omit it, which
// otherwise defaults to application/octet-stream and gets rejected by presign).
const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', avi: 'video/x-msvideo', mkv: 'video/x-matroska', '3gp': 'video/3gpp', m4v: 'video/mp4',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

// Imperative handle the parent uses to drive the editor (voice/AI insert + toolbar buttons).
type EditorApi = {
  getHTML: () => Promise<string>;
  setContent: (html: string) => void;
  toggleBold: () => void;
  toggleItalic: () => void;
  toggleBulletList: () => void;
};
type EditorUiState = { isFocused: boolean; isBoldActive: boolean; isItalicActive: boolean; isBulletListActive: boolean };

// The TenTap rich-text body, isolated so the bridge is created with the note's content as
// `initialContent`. That's the reliable way to load existing content: `setContent` after mount
// races the webview's readiness (it logs "Editor isn't ready yet" and drops the call, leaving the
// body empty until tapped). Mounting this only once the content is known sidesteps the race.
// Writing-area height bounds: TenTap's native auto-height is shimmed on Expo, so we grow the box
// from the content instead (see bodyHeight) - min keeps a comfortable default. No max: the box is
// inside the screen's own ScrollView, so a long paste/import should grow the box to fit and show
// from the top, not get clipped to a fixed height with its own internal (and separately-scrolled)
// WebView scroll. BODY_SANITY_MAX is only a backstop against a degenerate height estimate, not a
// real content limit - see bodyHeight below.
const BODY_MIN_HEIGHT = 180;
const BODY_SANITY_MAX_HEIGHT = 20000;
const NoteBodyEditor = forwardRef<EditorApi, {
  initialContent: string;
  onChange: (html: string) => void;
  onStateChange: (s: EditorUiState) => void;
}>(function NoteBodyEditor({ initialContent, onChange, onStateChange }, ref) {
  // No dynamicHeight: it overshoots to a huge height then snaps down while the webview boots, which
  // reads as a glitchy open. A fixed-height box (styles below) + internal scroll stays stable.
  const editor = useEditorBridge({ autofocus: false, avoidIosKeyboard: true, initialContent });
  const state = useBridgeState(editor);
  const html = useEditorContent(editor, { type: 'html', debounceInterval: 400 });

  // TenTap only resets the WebView's scroll position after boot when `dynamicHeight` is on (its own
  // fix for https://github.com/10play/10tap-editor/issues/236 / 244). We don't use dynamicHeight (see
  // note above), so without this the page can settle scrolled a few px past the top once fonts/layout
  // finish reflowing after `initialContent` loads - clipping the first line of imported/shared text.
  // Runs once, right as the freshly-mounted editor reports ready.
  useEffect(() => {
    if (!state.isReady) return;
    const t = setTimeout(() => {
      editor.webviewRef.current?.injectJavaScript('window.scrollTo(0, 0); true;');
    }, 100);
    return () => clearTimeout(t);
  }, [state.isReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // Estimate the writing-area height from the content so a long paste (e.g. text copied from a
  // webpage) grows the box to show all of it, instead of being clipped to a fixed height.
  const bodyHeight = useMemo(() => {
    const h = html || initialContent || '';
    const blocks = (h.match(/<\/(p|div|h[1-6]|li|blockquote)>|<br\s*\/?>/gi) || []).length;
    const text = h.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ');
    const wrapped = Math.ceil((text.trim().length || 1) / 36); // ~36 chars/line at the editor width
    const lines = Math.max(blocks + 1, wrapped);
    return Math.min(BODY_SANITY_MAX_HEIGHT, Math.max(BODY_MIN_HEIGHT, lines * 26 + 28));
  }, [html, initialContent]);

  useImperativeHandle(ref, () => ({
    getHTML: () => editor.getHTML(),
    setContent: (h: string) => editor.setContent(h),
    toggleBold: () => editor.toggleBold(),
    toggleItalic: () => editor.toggleItalic(),
    toggleBulletList: () => editor.toggleBulletList(),
  }), [editor]);

  useEffect(() => { if (html != null) onChange(html); }, [html]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    onStateChange({
      isFocused: state.isFocused,
      isBoldActive: state.isBoldActive,
      isItalicActive: state.isItalicActive,
      isBulletListActive: state.isBulletListActive,
    });
  }, [state.isFocused, state.isBoldActive, state.isItalicActive, state.isBulletListActive]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View style={s.richTextWrap}>
      <RichText editor={editor} style={[s.richText, { height: bodyHeight }]} scrollEnabled />
    </View>
  );
});

export default function EditorScreen() {
  const router = useRouter();
  const { noteId, shared } = useLocalSearchParams<{ noteId: string; shared?: string }>();
  const isNew = !noteId || noteId === 'new';

  const [title, setTitle] = useState('');
  const [tags, setTags] = useState<Tag[]>([]);
  const [isPinned, setIsPinned] = useState(false);
  const [linkedEventId, setLinkedEventId] = useState<string | null>(null);
  const [linkedEvent, setLinkedEvent] = useState<CalendarEvent | null>(null);
  const [showEventPicker, setShowEventPicker] = useState(false);
  const [pickerEvents, setPickerEvents] = useState<CalendarEvent[]>([]);
  const [loadingPickerEvents, setLoadingPickerEvents] = useState(false);
  const [saveStatus, setSaveStatus] = useState('');
  const [loading, setLoading] = useState(!isNew);

  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isProcessingText, setIsProcessingText] = useState(false);
  const [showAiSuggestion, setShowAiSuggestion] = useState(false);
  const [transcribedText, setTranscribedText] = useState('');
  const [images, setImages] = useState<string[]>([]);
  // A social post shared into the app (Instagram/Facebook/…) rendered as a card above the body.
  const [sourcePost, setSourcePost] = useState<SourcePost | null>(null);
  // True when images[0] is the card's thumbnail (kept out of the "Attached Images" gallery).
  const [thumbInImages0, setThumbInImages0] = useState(false);
  const [showImagePicker, setShowImagePicker] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isUploadingAttachment, setIsUploadingAttachment] = useState(false);
  // In-flight uploads (shared files + in-app picks): shown as filename + radial progress.
  const [pendingUploads, setPendingUploads] = useState<{ id: string; name: string; progress: number }[]>([]);
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  
  // Recording duration tracking for analytics
  const recordingStartTime = useRef<number | null>(null);
  const lastRecordingDuration = useRef<number>(0);

  const [showTagPicker, setShowTagPicker] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [selectedTagColor, setSelectedTagColor] = useState(TAG_COLORS[0].value);
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  // Rich-text editor (TenTap). Content is the note body HTML; `contentRef` holds the latest for
  // saving. The editor lives in <NoteBodyEditor>, mounted with the loaded content as initialContent
  // (below). We drive it imperatively via editorApiRef and mirror its UI state for the toolbar.
  const editorApiRef = useRef<EditorApi | null>(null);
  const [editorUi, setEditorUi] = useState<EditorUiState>({ isFocused: false, isBoldActive: false, isItalicActive: false, isBulletListActive: false });
  // HTML to load into the editor once the note is available (null until loaded - editor waits).
  const [seedHtml, setSeedHtml] = useState<string | null>(isNew && shared !== '1' ? '' : null);
  const seededRef = useRef(false);
  const seedPlainRef = useRef(''); // plaintext of the seed, to detect the "seed echo" vs a real edit

  // Auth state from context
  const { user: authUser } = useAuth();

  // Keyboard listener for showing format toolbar
  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardDidShow', () => setIsKeyboardVisible(true));
    const hideSub = Keyboard.addListener('keyboardDidHide', () => setIsKeyboardVisible(false));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // Refs for auto-save closure safety
  const noteIdRef = useRef(isNew ? '' : (noteId || ''));
  const isCreatedRef = useRef(!isNew);
  const titleRef = useRef(title);
  const contentRef = useRef('');
  const tagsRef = useRef(tags);
  const isPinnedRef = useRef(isPinned);
  const linkedEventIdRef = useRef<string | null>(linkedEventId);
  const imagesRef = useRef<string[]>(images);
  const attachmentsRef = useRef<Attachment[]>(attachments);
  const sourcePostRef = useRef<SourcePost | null>(sourcePost);
  const thumbInImages0Ref = useRef(thumbInImages0);
  // URL we've already attempted a client-side unfurl for (avoids re-fetching in a loop).
  const unfurlTriedRef = useRef<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True when this note originated from a share intent (analytics + discard-on-cancel).
  const isSharedRef = useRef(false);
  // True once the user actually edits - a pre-filled shared draft that's never touched
  // is discarded on back rather than silently saved.
  const userEditedRef = useRef(false);
  
  // State to track if note exists (for UI rendering like delete button)
  const [noteExists, setNoteExists] = useState(!isNew);
  const [showDeleteNoteModal, setShowDeleteNoteModal] = useState(false);
  const [deletingNote, setDeletingNote] = useState(false);

  useEffect(() => { titleRef.current = title; }, [title]);
  useEffect(() => { tagsRef.current = tags; }, [tags]);
  useEffect(() => { isPinnedRef.current = isPinned; }, [isPinned]);
  useEffect(() => { linkedEventIdRef.current = linkedEventId; }, [linkedEventId]);
  useEffect(() => { imagesRef.current = images; }, [images]);
  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);
  useEffect(() => { sourcePostRef.current = sourcePost; }, [sourcePost]);
  useEffect(() => { thumbInImages0Ref.current = thumbInImages0; }, [thumbInImages0]);

  // Once the note body is known, record it for save + seed-echo detection. <NoteBodyEditor> is
  // mounted with this as initialContent (below), so the editor itself loads reliably without a
  // setContent-after-mount race.
  useEffect(() => {
    if (seedHtml == null || seededRef.current) return;
    seededRef.current = true;
    contentRef.current = seedHtml;
    seedPlainRef.current = plainTextFromContent(seedHtml);
  }, [seedHtml]);

  // Editor edits (debounced HTML from <NoteBodyEditor>) → keep contentRef fresh + autosave. Ignore
  // the initial-content echo so loading a pristine note doesn't mark it dirty or create an empty one.
  const handleBodyChange = useCallback((html: string) => {
    contentRef.current = html;
    if (!userEditedRef.current && plainTextFromContent(html) === seedPlainRef.current) return;
    triggerAutoSave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Progressive enhancement for social cards without a thumbnail yet: fetch one (TikTok oEmbed,
  // or best-effort Open Graph for IG/FB/Threads) in the background, then fill in + persist. The
  // card shows instantly; this only upgrades it. Runs once per URL (retries on a fresh open).
  useEffect(() => {
    const sp = sourcePost;
    if (!sp || !needsUnfurl(sp.platform)) return;
    if (sp.thumbnail || sp.thumbUrl) return; // already have a thumbnail
    if (unfurlTriedRef.current === sp.url) return; // don't refetch the same url
    unfurlTriedRef.current = sp.url;
    let cancelled = false;
    (async () => {
      const res = await unfurl(sp.url, sp.platform);
      if (cancelled || (!res.thumbnailUrl && !res.title)) return;
      setSourcePost(prev => {
        if (!prev || prev.url !== sp.url) return prev;
        return {
          ...prev,
          title: prev.title || res.title || '',
          thumbUrl: res.thumbnailUrl || prev.thumbUrl,
          // Reddit reports image/video directly; a TikTok thumbnail is always a video poster.
          kind: res.kind || (prev.platform === 'tiktok' && res.thumbnailUrl ? 'video' : prev.kind),
        };
      });
      triggerAutoSave(); // persist the resolved thumbnail/title into the note marker
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcePost]);

  useEffect(() => {
    if (!isNew && noteId) loadNote(noteId);
  }, [noteId]);

  // Pre-fill from a shared draft (staged by ShareIntentHandler), then autosave it so the
  // shared note persists automatically - no manual save/edit required.
  useEffect(() => {
    if (!(isNew && shared === '1')) return;
    const draft = takePendingShareDraft();
    if (!draft) return;
    isSharedRef.current = true;
    if (draft.title) setTitle(draft.title);
    contentRef.current = draft.content || ''; // hold body before the WebView seeds
    setSeedHtml(draft.content || ''); // seed the editor with the shared body (or empty)
    if (draft.tags?.length) setTags(draft.tags as Tag[]);
    if (draft.images?.length) setImages(draft.images);
    // A recognized social post → show its card. The normalizer already put its thumbnail at
    // images[0] (image share or generated video frame), so flag it out of the gallery.
    if (draft.sourcePost) {
      setSourcePost(draft.sourcePost);
      setThumbInImages0(!!draft.sourcePost.thumbnail);
    }
    // Big shared files upload here (in the editor) with visible radial progress.
    if (draft.pendingFiles?.length) uploadFiles(draft.pendingFiles);
    // Autosave the shared draft (marks it committed + schedules the debounced save). The
    // debounced save reads refs, which are populated by the sync effects after this render.
    triggerAutoSave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadNote = async (id: string) => {
    try {
      // Local-first seed: MemoPad is offline-first, so the local copy is the editing-session source
      // of truth. Seed the editor from it immediately (no network wait) so the body appears at once;
      // reconcile metadata with the server below. Avoids the visible lag of waiting on notesApi.get.
      const localCopy = (await getLocalNotes()).find(n => n.id === id);
      let bodySeeded = false;
      if (localCopy) {
        const lp = parseSourcePost(localCopy.content || '');
        contentRef.current = lp.content || '';
        setSeedHtml(lp.content || '');
        bodySeeded = true;
        if (lp.sourcePost) { setSourcePost(lp.sourcePost); setThumbInImages0(lp.thumbInImages0); }
      }

      let note: any;
      if (id.startsWith('local_')) {
        // Not-yet-synced note - the local copy is all there is.
        note = localCopy;
        if (!note) throw new Error('local note not found');
      } else {
        try {
          note = await decryptNoteFromServer(await notesApi.get(id));
        } catch (e) {
          // Offline / fetch failed - fall back to the local copy if we have one.
          if (!localCopy) throw e;
          note = localCopy;
        }
      }
      setTitle(note.title);
      // A shared-post card is persisted as a marker at the end of content; split it back out.
      const parsed = parseSourcePost(note.content || '');
      // Body already seeded from local (instant). Only seed from the server copy if we had no local
      // copy - re-seeding after the WebView mounts can't take effect (initialContent is fixed).
      if (!bodySeeded) {
        contentRef.current = parsed.content || '';
        setSeedHtml(parsed.content || '');
        if (parsed.sourcePost) {
          setSourcePost(parsed.sourcePost);
          setThumbInImages0(parsed.thumbInImages0);
        }
      }
      setTags(note.tags);
      setIsPinned(note.is_pinned);
      setLinkedEventId(note.linked_event_id);
      setImages(note.images || []);
      setAttachments(note.attachments || []);
      noteIdRef.current = note.id;
      isCreatedRef.current = true;
      setNoteExists(true);
      
      // Fetch linked event details if exists
      if (note.linked_event_id) {
        try {
          const event = await decryptEventFromServer(await eventsApi.get(note.linked_event_id));
          setLinkedEvent(event);
        } catch (e) {
          console.error('Failed to load linked event:', e);
        }
      }
    } catch (e) {
      console.error('Failed to load note:', e);
    } finally {
      setLoading(false);
    }
  };

  // Fetch event when linkedEventId changes (e.g., after creating event)
  useEffect(() => {
    if (linkedEventId && !linkedEvent) {
      eventsApi.get(linkedEventId)
        .then(decryptEventFromServer)
        .then(event => setLinkedEvent(event))
        .catch(e => console.error('Failed to load event:', e));
    } else if (!linkedEventId) {
      setLinkedEvent(null);
    }
  }, [linkedEventId]);

  // Refresh note and linked event data when screen comes back into focus
  // This ensures event details are shown after creating/editing an event
  useFocusEffect(
    useCallback(() => {
      const refreshData = async () => {
        // Check for pending event ID from AsyncStorage (for new notes)
        try {
          const pendingEventId = await AsyncStorage.getItem('pendingLinkedEventId');
          if (pendingEventId) {
            // Clear it immediately
            await AsyncStorage.removeItem('pendingLinkedEventId');
            // Track event scheduling if this is a new linked event
            if (!linkedEventIdRef.current) {
              trackNoteEventScheduled();
            }
            // Set the linked event ID
            setLinkedEventId(pendingEventId);
            // Fetch the event details
            const event = await decryptEventFromServer(await eventsApi.get(pendingEventId));
            setLinkedEvent(event);
            return;
          }
        } catch (e) {
          console.error('Error checking pending event:', e);
        }
        
        // If we have a synced note, reload it to get the latest linked_event_id.
        // Skip for not-yet-synced local notes (no server row yet → would 404).
        if (noteIdRef.current && isCreatedRef.current && !noteIdRef.current.startsWith('local_')) {
          try {
            const note = await notesApi.get(noteIdRef.current);
            if (note.linked_event_id) {
              // Track event scheduling if this is a new linked event
              if (!linkedEventIdRef.current && note.linked_event_id) {
                trackNoteEventScheduled();
              }
              setLinkedEventId(note.linked_event_id);
              // Fetch the event details
              const event = await decryptEventFromServer(await eventsApi.get(note.linked_event_id));
              setLinkedEvent(event);
            }
          } catch (e) {
            console.error('Failed to refresh note data:', e);
          }
        } else if (linkedEventId) {
          // Just refresh event if we already have a linkedEventId
          try {
            const event = await decryptEventFromServer(await eventsApi.get(linkedEventId));
            setLinkedEvent(event);
          } catch (e) {
            console.error('Failed to refresh event:', e);
          }
        }
      };
      
      refreshData();
    }, [linkedEventId])
  );

  // Pull the newest HTML straight from the editor bridge. The reactive contentRef lags by the
  // editor's debounce, so persisting without this could write stale content. Raced against a
  // short timeout: if the webview bridge isn't ready yet, getHTML's message is silently dropped
  // and its promise never settles - without the race, awaiting it would hang navigation.
  const syncLatestContent = useCallback(async () => {
    try {
      const latest = await Promise.race([
        editorApiRef.current?.getHTML(),
        new Promise<undefined>((resolve) => setTimeout(resolve, 400)),
      ]);
      if (typeof latest === 'string') contentRef.current = latest;
    } catch {}
  }, []);

  // Confirm a save happened with a light haptic tap.
  const signalSaved = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  }, []);

  // Offline-first save: writes locally + enqueues for sync. Encryption happens once,
  // at the offlineSync push boundary. `push: false` (autosave) defers the network sync
  // so a mid-session id swap can't strand `noteIdRef`; the queue is flushed on exit.
  const persistLocal = useCallback(async (opts: { push?: boolean } = {}): Promise<void> => {
    // Every persist path (autosave, back, save-and-back, future flushes) captures the very
    // latest keystrokes here, so no caller has to remember to flush first.
    await syncLatestContent();
    const draft = {
      title: titleRef.current,
      // The shared-post card rides along as a marker appended to the body (stripped on load).
      content: contentRef.current + serializeSourcePost(sourcePostRef.current, thumbInImages0Ref.current),
      tags: tagsRef.current,
      is_pinned: isPinnedRef.current,
      linked_event_id: linkedEventIdRef.current,
      images: imagesRef.current,
      attachments: attachmentsRef.current,
    };
    if (!isCreatedRef.current) {
      const created = await createNoteOffline(draft, { push: opts.push });
      noteIdRef.current = created.id;
      isCreatedRef.current = true;
      setNoteExists(true);
      setNewNoteId(created.id); // let the notes list play a one-time "newly created" glow on this card
      trackNoteCreated({
        has_scheduled_event: !!linkedEventIdRef.current,
        has_image_attached: imagesRef.current.length > 0,
        is_shared: isSharedRef.current,
      });
    } else if (noteIdRef.current) {
      await updateNoteOffline(noteIdRef.current, draft, { push: opts.push });
      trackNoteEdited();
    }
  }, []);

  const triggerAutoSave = useCallback(() => {
    userEditedRef.current = true; // any edit commits a shared draft (no longer discardable)
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setSaveStatus('Unsaved changes');
    saveTimerRef.current = setTimeout(async () => {
      setSaveStatus('Saving...');
      try {
        // Local write only (push deferred to exit/background) - always succeeds offline.
        await persistLocal({ push: false });
        setSaveStatus('All changes saved');
        signalSaved();
      } catch (e: any) {
        setSaveStatus('Failed to save');
        console.error('Autosave error:', e);
      }
    }, 800);
  }, [persistLocal, signalSaved]);

  const handleBack = useCallback(async () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    await syncLatestContent(); // capture the very last keystrokes before persisting
    try {
      const hasContent = !!(titleRef.current || contentRef.current || linkedEventIdRef.current || imagesRef.current.length > 0 || attachmentsRef.current.length > 0 || sourcePostRef.current);
      // Persist locally; only create a brand-new note if it actually has content.
      if (isCreatedRef.current ? !!noteIdRef.current : hasContent) {
        await persistLocal({ push: true });
        // Flush the queue so the note reaches the server on exit (best-effort).
        processSyncQueue().catch(() => {});
      }
    } catch (e) {
      console.error('Save on back failed:', e);
    }
    router.back();
  }, [router, persistLocal, syncLatestContent]);

  const handleTitleChange = (text: string) => {
    setTitle(text);
    triggerAutoSave();
  };

  // Insert plain text (voice transcription / AI output) into the rich editor as new paragraphs.
  const escapeHtml = (t: string) =>
    t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const appendToEditor = async (text: string) => {
    const clean = (text || '').trim();
    if (!clean) return;
    const paras = clean.split(/\n{2,}/).map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
    let current = '';
    try { current = (await editorApiRef.current?.getHTML()) || ''; } catch {}
    const base = current.replace(/<p><\/p>\s*$/i, ''); // drop a trailing empty paragraph
    editorApiRef.current?.setContent(base + paras);
    userEditedRef.current = true;
    triggerAutoSave();
  };

  // Format date/time for display
  const formatEventDateTime = (dateStr: string): string => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  // Format reminder minutes to readable text
  const formatReminderMinutes = (minutes: number | null): string => {
    if (!minutes) return 'No reminder';
    if (minutes === 5) return '5 minutes before';
    if (minutes === 15) return '15 minutes before';
    if (minutes === 30) return '30 minutes before';
    if (minutes === 60) return '1 hour before';
    if (minutes === 1440) return '1 day before';
    return `${minutes} minutes before`;
  };

  const handleShare = async () => {
    const plainContent = plainTextFromContent(contentRef.current);
    if (!title && !plainContent && !linkedEvent) {
      Alert.alert('Nothing to Share', 'Please add a title or content to your note first.');
      return;
    }

    // Build share text with all details - clean format without horizontal lines
    let shareText = '';
    
    // Add title
    if (title) {
      shareText += `📝 ${title}\n\n`;
    }
    
    // Add content
    if (plainContent) {
      shareText += plainContent.trim() + '\n';
    }
    
    // Add tags if any
    if (tags.length > 0) {
      shareText += '\n🏷️ Tags: ' + tags.map(t => t.name).join(', ') + '\n';
    }

    // Add the shared post's metadata (platform, caption/title, original link) so
    // forwarding a note that started as a shared link doesn't drop that context.
    if (sourcePost) {
      shareText += `\n🔗 ${sourcePost.label}\n\n`;
      if (sourcePost.title) {
        shareText += `${sourcePost.title}\n`;
      }
      shareText += `${sourcePost.url}\n`;
    }

    // Add linked event details with Event header
    if (linkedEvent) {
      shareText += '\n📅 Event\n\n';
      shareText += `Title: ${linkedEvent.title}\n`;
      shareText += `Start: ${formatEventDateTime(linkedEvent.start_time)}\n`;
      shareText += `End: ${formatEventDateTime(linkedEvent.end_time)}\n`;
      if (linkedEvent.location) {
        shareText += `Location: ${linkedEvent.location}\n`;
      }
      if (linkedEvent.reminder_minutes) {
        shareText += `Reminder: ${formatReminderMinutes(linkedEvent.reminder_minutes)}\n`;
      }
      if (linkedEvent.description) {
        shareText += `Description: ${linkedEvent.description}\n`;
      }
    }

    // Append secure download links for attachments (valid ~7 days)
    if (attachments.length > 0) {
      shareText += '\n📎 Attachments\n';
      for (const att of attachments) {
        try {
          const { url } = await attachmentsApi.downloadUrl(att.key);
          shareText += `${att.filename}: ${url}\n`;
        } catch {
          shareText += `${att.filename}: (link unavailable)\n`;
        }
      }
    }

    try {
      const result = await Share.share({
        message: shareText.trim(),
        title: title || 'My Note',
      });

      if (result.action === Share.sharedAction) {
        // Track the share event
        const shareMethod = result.activityType || 'other';
        let method: 'link' | 'email' | 'message' | 'social' | 'other' = 'other';
        
        if (shareMethod.includes('mail') || shareMethod.includes('email')) {
          method = 'email';
        } else if (shareMethod.includes('message') || shareMethod.includes('sms') || shareMethod.includes('chat')) {
          method = 'message';
        } else if (shareMethod.includes('facebook') || shareMethod.includes('twitter') || shareMethod.includes('instagram') || shareMethod.includes('social')) {
          method = 'social';
        } else if (shareMethod.includes('link') || shareMethod.includes('copy')) {
          method = 'link';
        }
        
        trackNoteShared(method);
        console.log('Shared via:', result.activityType);
      }
    } catch (error) {
      console.error('Share error:', error);
      Alert.alert('Share Failed', 'Unable to share the note. Please try again.');
    }
  };

  const startRecording = async () => {
    try {
      const status = await AudioModule.requestRecordingPermissionsAsync();
      if (!status.granted) {
        Alert.alert('Permission Needed', 'Microphone access is required for voice input.');
        return;
      }
      
      // Configure audio mode for recording (required on iOS)
      await setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: true,
      });
      
      await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();
      setIsRecording(true);
      // Track recording start time for duration calculation
      recordingStartTime.current = Date.now();
      // Track voice recording started event
      trackVoiceRecordingStarted();
    } catch (e) {
      console.error('Recording start failed:', e);
      Alert.alert('Error', 'Could not start recording.');
    }
  };

  const stopRecording = async () => {
    try {
      setIsRecording(false);
      await audioRecorder.stop();
      const uri = audioRecorder.uri;
      console.log('Recording stopped. URI:', uri);
      
      // Calculate recording duration
      const recordingDuration = recordingStartTime.current 
        ? Math.round((Date.now() - recordingStartTime.current) / 1000)
        : 0;
      recordingStartTime.current = null;
      lastRecordingDuration.current = recordingDuration; // Store for transcription inserted tracking
      
      // Track voice recording completed
      trackVoiceRecordingCompleted(recordingDuration);
      
      if (!uri) {
        console.error('No recording URI available');
        Alert.alert('Error', 'Recording failed. No audio file was created.');
        return;
      }

      setIsTranscribing(true);
      console.log('Starting transcription for:', uri);
      const result = await transcribeApi.transcribe(uri);
      console.log('Transcription result:', result);
      
      // Store the transcribed text and show AI suggestion modal
      setTranscribedText(result.text);
      setIsTranscribing(false);
      setShowAiSuggestion(true);
    } catch (e) {
      console.error('Transcription failed:', e);
      Alert.alert('Error', 'Voice transcription failed. Please try again.');
      setIsTranscribing(false);
    }
  };

  // Handle AI text processing
  const handleAiProcess = async (action: 'organize' | 'summarize' | 'keep') => {
    setShowAiSuggestion(false);
    
    // Helper function to track and insert transcription
    const insertTranscription = (textToInsert: string) => {
      const wordCount = textToInsert.split(/\s+/).filter(Boolean).length;
      trackVoiceTranscriptionInserted(lastRecordingDuration.current, wordCount);
    };
    
    if (action === 'keep') {
      // Just add the transcribed text as-is
      await appendToEditor(transcribedText);
      insertTranscription(transcribedText);
      return;
    }

    try {
      setIsProcessingText(true);
      const result = await textProcessApi.processText(transcribedText, action);
      await appendToEditor(result.text);
      insertTranscription(result.text);
    } catch (e) {
      console.error('Text processing failed:', e);
      Alert.alert('Error', 'AI processing failed. Adding original text.');
      // Fallback to original text
      await appendToEditor(transcribedText);
      insertTranscription(transcribedText);
    } finally {
      setIsProcessingText(false);
      setTranscribedText('');
    }
  };

  // Image picker functions
  const takePhoto = async () => {
    setShowImagePicker(false);
    
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Needed', 'Camera access is required to take photos.');
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [4, 3],
      quality: 0.7,
      base64: true,
    });

    if (!result.canceled && result.assets[0]) {
      // Store as base64 data URI for persistence
      const base64Data = result.assets[0].base64;
      if (base64Data) {
        const dataUri = `data:image/jpeg;base64,${base64Data}`;
        const newImages = [...images, dataUri];
        setImages(newImages);
        // Track image attachment
        trackNoteImageAttached(newImages.length);
        triggerAutoSave();
      }
    }
  };

  const pickFromGallery = async () => {
    setShowImagePicker(false);
    
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Needed', 'Gallery access is required to select photos.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [4, 3],
      quality: 0.7,
      allowsMultipleSelection: true,
      selectionLimit: 5,
      base64: true,
    });

    if (!result.canceled && result.assets.length > 0) {
      // Store as base64 data URIs for persistence
      const newImageUris = result.assets
        .filter(asset => asset.base64)
        .map(asset => `data:image/jpeg;base64,${asset.base64}`);
      if (newImageUris.length > 0) {
        const newImages = [...images, ...newImageUris];
        setImages(newImages);
        // Track image attachment (total count after adding)
        trackNoteImageAttached(newImages.length);
        triggerAutoSave();
      }
    }
  };

  const removeImage = (index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index));
    triggerAutoSave();
  };

  // Open the original social post in the browser.
  const openSourcePost = () => {
    if (sourcePost?.url) WebBrowser.openBrowserAsync(sourcePost.url).catch(() => {});
  };

  // Drop the shared-post card (and its thumbnail, which lives at images[0]).
  const removeSourcePost = () => {
    if (thumbInImages0) {
      setImages(prev => prev.slice(1));
      setThumbInImages0(false);
    }
    setSourcePost(null);
    triggerAutoSave();
  };

  // File attachment (paperclip) - picks a file, uploads to storage, embeds metadata.
  // Online-direct, matching the editor's existing save model. Never base64-inlines.
  const MAX_ATTACHMENT_MB = 100;
  const MAX_PICK_AT_ONCE = 10;

  // Upload files (shared or in-app-picked) with per-file radial progress. Each completed
  // upload is appended to attachments[] and autosaved. Used by both the share pre-fill
  // and pickAttachment (new + edit), so progress shows consistently everywhere.
  const uploadFiles = useCallback(async (files: UploadFile[]) => {
    for (const raw of files) {
      // Recover missing size/MIME before presign. The picker (and Android cloud/content URIs) can
      // omit both: a missing size gets sent as 0 and rejected as "too large", and a missing MIME
      // defaults to octet-stream and is rejected as "type not allowed". copyToCacheDirectory makes
      // the uri a local file, so getInfoAsync reliably yields the size.
      const ext = (raw.name.includes('.') ? raw.name.split('.').pop() : '')?.toLowerCase() || '';
      let size = raw.size ?? 0;
      if (!size) {
        try {
          const info = await FileSystem.getInfoAsync(raw.uri);
          if (info.exists && info.size) size = info.size;
        } catch { /* fall through - presign will surface a clear error */ }
      }
      const mimeType = (!raw.mimeType || raw.mimeType === 'application/octet-stream')
        ? (EXT_MIME[ext] || raw.mimeType || 'application/octet-stream')
        : raw.mimeType;
      const file: UploadFile = { ...raw, size, mimeType };

      if (size > MAX_ATTACHMENT_MB * 1024 * 1024) {
        Alert.alert('File too large', `${file.name} is over ${MAX_ATTACHMENT_MB}MB and can’t be attached.`);
        continue;
      }
      const uploadId = `up_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      setPendingUploads(prev => [...prev, { id: uploadId, name: file.name, progress: 0 }]);
      try {
        const meta = await uploadAttachmentWithProgress(file, (p) =>
          setPendingUploads(prev => prev.map(u => (u.id === uploadId ? { ...u, progress: p } : u))),
        );
        setAttachments(prev => [...prev, meta]);
        triggerAutoSave();
      } catch (e: any) {
        // Surface the real reason (and log it) instead of a blanket "Couldn't upload".
        const msg = String(e?.message || '');
        console.error('Attachment upload failed:', file.name, file.mimeType, size, '→', msg);
        let reason = `Couldn’t upload ${file.name}.`;
        if (msg.includes('503') || msg.includes('not enabled')) reason = 'File attachments aren’t enabled on the server yet.';
        else if (msg.includes('File type not allowed')) reason = `${file.name}: that file type isn’t supported.`;
        else if (msg.includes('File too large') || msg.includes('EntityTooLarge')) reason = `${file.name} is too large to attach.`;
        else if (msg.includes('network error')) reason = `Network error uploading ${file.name}. Check your connection and try again.`;
        Alert.alert('Upload failed', reason);
      } finally {
        setPendingUploads(prev => prev.filter(u => u.id !== uploadId));
      }
    }
  }, [triggerAutoSave]);

  // Pick up to MAX_PICK_AT_ONCE files at once and upload each (online-direct).
  const pickAttachment = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: true,
      });
      if (result.canceled || !result.assets || result.assets.length === 0) return;

      let assets = result.assets;
      if (assets.length > MAX_PICK_AT_ONCE) {
        Alert.alert('Too many files', `You can attach up to ${MAX_PICK_AT_ONCE} files at once. Adding the first ${MAX_PICK_AT_ONCE}.`);
        assets = assets.slice(0, MAX_PICK_AT_ONCE);
      }
      // Upload with visible radial progress (same path as shared files).
      uploadFiles(assets.map(a => ({
        uri: a.uri,
        name: a.name || 'file',
        mimeType: a.mimeType || 'application/octet-stream',
        size: a.size ?? 0,
      })));
    } catch (e) {
      console.error('Attachment pick failed:', e);
    }
  };

  // Open an attachment (image/video/audio/pdf/doc) via a presigned GET URL.
  const openAttachment = async (att: Attachment) => {
    try {
      const { url } = await attachmentsApi.downloadUrl(att.key);
      await WebBrowser.openBrowserAsync(url);
    } catch (e) {
      console.error('Open attachment failed:', e);
      Alert.alert('Could not open', 'Unable to open this file right now. Please try again.');
    }
  };

  const attachmentIcon = (mime: string): keyof typeof MaterialIcons.glyphMap => {
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'movie';
    if (mime.startsWith('audio/')) return 'audiotrack';
    if (mime === 'application/pdf') return 'picture-as-pdf';
    return 'insert-drive-file';
  };

  const removeAttachment = (att: Attachment) => {
    setAttachments(prev => prev.filter(a => a.id !== att.id));
    triggerAutoSave();
    // Best-effort remote cleanup; storage lifecycle/next save reconciles on failure.
    attachmentsApi.remove(att.key).catch(() => {});
  };

  // Tap the linked-event card's delete control -> choose to unlink or fully delete.
  const handleRemoveLinkedEvent = () => {
    if (!linkedEvent) return;
    const event = linkedEvent;

    // Persist the cleared link to the server BEFORE updating local state. The
    // focus refresh re-reads the note on every focus/linkedEventId change, so
    // relying on the debounced autosave would race it and re-link the event
    // from the still-stale server value.
    const clearLinkOnServer = async () => {
      if (noteIdRef.current && isCreatedRef.current) {
        await updateNoteOffline(noteIdRef.current, { linked_event_id: null });
      }
    };

    Alert.alert(
      'Linked Event',
      `"${event.title}"\n\nUnlink keeps the event in your Calendar. Delete removes it everywhere.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unlink',
          onPress: async () => {
            try {
              await clearLinkOnServer();
            } catch (e) {
              console.error('Unlink failed:', e);
              Alert.alert('Error', 'Could not unlink the event. Please try again.');
              return;
            }
            setLinkedEventId(null);
            setLinkedEvent(null);
            // Best-effort: drop this note from the event's linked_note_ids
            try {
              const remaining = (event.linked_note_ids || []).filter(id => id !== noteIdRef.current);
              await eventsApi.update(event.id, { linked_note_ids: remaining });
            } catch {}
          },
        },
        {
          text: 'Delete Event',
          style: 'destructive',
          onPress: async () => {
            try {
              await clearLinkOnServer();
              await eventsApi.delete(event.id);
            } catch (e) {
              console.error('Delete event failed:', e);
              Alert.alert('Error', 'Could not delete the event. Please try again.');
              return;
            }
            setLinkedEventId(null);
            setLinkedEvent(null);
          },
        },
      ],
    );
  };

  // Open a picker of existing events to link to this note.
  const openEventPicker = async () => {
    setShowEventPicker(true);
    setLoadingPickerEvents(true);
    try {
      const events = await decryptEventsFromServer<CalendarEvent>(await eventsApi.getAll());
      setPickerEvents(events);
    } catch (e) {
      console.error('Load events for picker failed:', e);
      setPickerEvents([]);
    } finally {
      setLoadingPickerEvents(false);
    }
  };

  const linkExistingEvent = async (event: CalendarEvent) => {
    setShowEventPicker(false);
    setLinkedEventId(event.id);
    setLinkedEvent(event);
    triggerAutoSave();
    // Best-effort: add this note to the event's linked_note_ids (only if the note exists)
    try {
      const noteId = noteIdRef.current;
      if (noteId) {
        const ids = Array.from(new Set([...(event.linked_note_ids || []), noteId]));
        await eventsApi.update(event.id, { linked_note_ids: ids });
      }
    } catch {}
  };

  const addTag = () => {
    if (!newTagName.trim()) return;
    if (tags.length >= 3) {
      Alert.alert('Maximum Tags', 'You can add up to 3 tags per note.');
      return;
    }
    const newTags = [...tags, { name: newTagName.trim(), color: selectedTagColor }];
    setTags(newTags);
    setNewTagName('');
    setShowTagPicker(false);
    triggerAutoSave();
  };

  const removeTag = (index: number) => {
    const newTags = tags.filter((_, i) => i !== index);
    setTags(newTags);
    triggerAutoSave();
  };

  const togglePin = () => {
    setIsPinned(!isPinned);
    triggerAutoSave();
  };

  // Save note and show sign-up prompt (only on first note save)
  const handleSaveAndBack = async () => {
    // Cancel any pending autosave timer so it can't double-fire with the save below.
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    await syncLatestContent(); // capture the very last keystrokes before the empty-check + save
    // Nothing to save? (also save if there's a linked event, images, or attachments -
    // e.g. a photo/audio/video share with no typed title/body)
    if (!title.trim() && !plainTextFromContent(contentRef.current) && !linkedEventIdRef.current
        && imagesRef.current.length === 0 && attachmentsRef.current.length === 0
        && !sourcePostRef.current) {
      router.replace('/(tabs)');
      return;
    }

    setSaveStatus('Saving...');
    let saveSucceeded = false;

    try {
      await persistLocal({ push: true });
      processSyncQueue().catch(() => {});
      saveSucceeded = true;
      setSaveStatus('All changes saved');
    } catch (e: any) {
      setSaveStatus('Could not save - please try again later');
      console.error('Save error:', e);
      // Continue to navigate back even if save failed - don't trap the user
    }
    
    // Always navigate back, regardless of save success
    // Check if user needs to see sign-up prompt first
    if (saveSucceeded) {
      try {
        const modalDismissed = await authStorage.isModalDismissed();
        const userHasEmail = authUser?.email;
        const userVerified = authUser?.email_verified;

        if (!modalDismissed && !userHasEmail && !userVerified) {
          await authStorage.setFirstNoteSaved();
          router.replace('/signup'); // Prompt guest to create an account
          return; // Don't navigate to tabs yet
        }
      } catch (e) {
        console.error('Error checking auth state:', e);
      }
    }
    
    // Navigate back
    router.replace('/(tabs)');
  };

  const handleDelete = () => {
    setShowDeleteNoteModal(true);
  };

  const cancelDeleteNote = () => {
    setShowDeleteNoteModal(false);
  };

  const confirmDeleteNote = async () => {
    setDeletingNote(true);
    try {
      // Use noteIdRef or the noteId from params
      const idToDelete = noteIdRef.current || noteId;
      if (idToDelete) {
        await notesApi.delete(idToDelete);
        // Track note deletion
        trackNoteDeleted();
      }
    } catch (e) {
      console.error('Delete failed:', e);
      setDeletingNote(false);
      Alert.alert('Error', 'Failed to delete note. Please try again.');
      return; // Don't navigate away if delete failed
    }
    setDeletingNote(false);
    setShowDeleteNoteModal(false);
    router.back();
  };

  // No full-screen loader: render the editor chrome immediately. The body seeds instantly from the
  // local copy (local-first in loadNote) and metadata fills in as it resolves - so the screen opens
  // at once instead of blocking on a spinner until the network load finishes.

  return (
    <SafeAreaView style={s.container}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {/* Header */}
        <View style={s.header}>
          <TouchableOpacity testID="back-btn" style={s.headerBtn} onPress={handleSaveAndBack}>
            <MaterialIcons name="arrow-back" size={28} color={C.text} />
            <Text style={s.headerBtnLabel}>Back</Text>
          </TouchableOpacity>
          <View style={s.headerRight}>
            {/* User Avatar - reads user/logout from auth context internally */}
            <UserAvatar size={36} />
          </View>
        </View>

        {/* Save Status */}
        {saveStatus ? (
          <View style={s.statusBar}>
            <MaterialIcons
              name={
                saveStatus === 'All changes saved' ? 'check-circle' :
                saveStatus === 'Saving...' ? 'sync' : 'error'
              }
              size={16}
              color={
                saveStatus === 'All changes saved' ? C.success :
                saveStatus === 'Failed to save' ? C.error : C.textSec
              }
            />
            <Text style={[s.statusText, {
              color: saveStatus === 'All changes saved' ? C.success :
                saveStatus === 'Failed to save' ? C.error : C.textSec,
            }]}>
              {saveStatus}
            </Text>
          </View>
        ) : null}

        <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent} keyboardShouldPersistTaps="handled">
          {/* Title */}
          <TextInput
            testID="note-title-input"
            style={s.titleInput}
            placeholder="Note title..."
            placeholderTextColor={C.borderSub}
            value={title}
            onChangeText={handleTitleChange}
            returnKeyType="next"
          />

          {/* Tags */}
          <View style={s.tagsSection}>
            <View style={s.tagsRow}>
              {tags.map((tag, i) => (
                <TouchableOpacity
                  key={i}
                  testID={`tag-${i}`}
                  style={[s.tagChip, { backgroundColor: tag.color + '20', borderColor: tag.color }]}
                  onPress={() => removeTag(i)}
                >
                  <Text style={[s.tagChipText, { color: tag.color }]}>{tag.name}</Text>
                  <MaterialIcons name="close" size={16} color={tag.color} />
                </TouchableOpacity>
              ))}
              {tags.length < 3 && (
                <TouchableOpacity
                  testID="add-tag-btn"
                  style={s.addTagBtn}
                  onPress={() => setShowTagPicker(!showTagPicker)}
                >
                  <MaterialIcons name="sell" size={18} color={C.text} />
                  <Text style={s.addTagText}>Add Tag</Text>
                </TouchableOpacity>
              )}
            </View>

            {showTagPicker && (
              <View style={s.tagPicker}>
                <TextInput
                  testID="tag-name-input"
                  style={s.tagInput}
                  placeholder="Tag name..."
                  placeholderTextColor={C.borderSub}
                  value={newTagName}
                  onChangeText={setNewTagName}
                />
                <View style={s.colorRow}>
                  {TAG_COLORS.map((c) => (
                    <TouchableOpacity
                      key={c.value}
                      testID={`color-${c.name}`}
                      style={[
                        s.colorDot,
                        { backgroundColor: c.value },
                        selectedTagColor === c.value && s.colorDotSel,
                      ]}
                      onPress={() => setSelectedTagColor(c.value)}
                    />
                  ))}
                </View>
                <TouchableOpacity testID="confirm-tag-btn" style={s.confirmTagBtn} onPress={addTag}>
                  <Text style={s.confirmTagText}>Add Tag</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>

          {/* Content - the shared-post card sits at the top of the input box, then the writing area */}
          <View style={s.contentContainer}>
            <View style={s.inputBox}>
              {/* Shared social post card (Instagram/Facebook/WhatsApp/YouTube/…) - links back to the post */}
              {sourcePost && (
                <SharedPostCard
                  style={s.cardInInput}
                  source={thumbInImages0 && images[0] ? { ...sourcePost, thumbnail: images[0] } : sourcePost}
                  onOpen={openSourcePost}
                  onRemove={removeSourcePost}
                />
              )}
              {/* Rich-text body (TenTap WebView). Mounted only once the note content is known, so the
                  bridge is created with it as initialContent - reliable load, no setContent race. */}
              {seedHtml != null ? (
                <NoteBodyEditor
                  ref={editorApiRef}
                  initialContent={seedHtml}
                  onChange={handleBodyChange}
                  onStateChange={setEditorUi}
                />
              ) : (
                <View style={s.richTextWrap}><View style={{ height: 180 }} /></View>
              )}
              {/* Attach-file footer - a WebView can't be overlaid, so the paperclip sits below it */}
              <View style={s.editorFooter}>
                <TouchableOpacity
                  testID="attach-file-btn"
                  style={s.attachInline}
                  onPress={pickAttachment}
                  disabled={isUploadingAttachment}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  {isUploadingAttachment ? (
                    <ActivityIndicator size="small" color={C.secondary} />
                  ) : (
                    <MaterialIcons name="attach-file" size={22} color={C.secondary} />
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </View>

          {/* Attachments Section */}
          {(attachments.length > 0 || pendingUploads.length > 0) && (
            <View style={s.imagesContainer}>
              <Text style={s.imagesSectionTitle}>Attachments</Text>
              {/* In-flight uploads: filename + radial progress */}
              {pendingUploads.map((u) => (
                <View key={u.id} style={s.attachmentRow} testID={`uploading-${u.id}`}>
                  <MaterialIcons name="upload-file" size={22} color={C.secondary} />
                  <Text style={s.attachmentName} numberOfLines={1}>{u.name}</Text>
                  <RadialProgress progress={u.progress} size={22} />
                </View>
              ))}
              {attachments.map((att) => (
                <TouchableOpacity
                  key={att.id}
                  style={s.attachmentRow}
                  onPress={() => openAttachment(att)}
                  activeOpacity={0.7}
                  testID={`open-attachment-${att.id}`}
                >
                  <MaterialIcons name={attachmentIcon(att.mime_type)} size={22} color={C.secondary} />
                  <Text style={s.attachmentName} numberOfLines={1}>{att.filename}</Text>
                  <MaterialIcons name="open-in-new" size={18} color={C.borderSub} />
                  <TouchableOpacity
                    testID={`remove-attachment-${att.id}`}
                    onPress={() => removeAttachment(att)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <MaterialIcons name="close" size={20} color={C.error} />
                  </TouchableOpacity>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {/* Images Section (the card's thumbnail lives at images[0] and is shown by the card, not here) */}
          {images.filter((_, i) => !(thumbInImages0 && i === 0)).length > 0 && (
            <View style={s.imagesContainer}>
              <Text style={s.imagesSectionTitle}>Attached Images</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.imagesScroll}>
                {images.map((uri, index) => {
                  if (thumbInImages0 && index === 0) return null;
                  return (
                    <View key={index} style={s.imageWrapper}>
                      <Image source={{ uri }} style={s.attachedImage} />
                      <TouchableOpacity
                        style={s.removeImageBtn}
                        onPress={() => removeImage(index)}
                      >
                        <MaterialIcons name="close" size={16} color={C.primaryFg} />
                      </TouchableOpacity>
                    </View>
                  );
                })}
              </ScrollView>
            </View>
          )}

          {/* Calendar Link / Event Details */}
          {linkedEvent ? (
            <TouchableOpacity
              testID="linked-event-card"
              style={s.eventCard}
              onPress={() =>
                router.push({
                  pathname: '/event-editor',
                  params: {
                    eventId: linkedEvent.id,
                    noteId: noteIdRef.current || 'new',
                  },
                })
              }
            >
              <View style={s.eventHeader}>
                <MaterialIcons name="event" size={24} color={C.secondary} />
                <Text style={s.eventHeaderText}>Linked Event</Text>
                <TouchableOpacity
                  testID="remove-linked-event-btn"
                  onPress={handleRemoveLinkedEvent}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  style={{ paddingHorizontal: 4 }}
                >
                  <MaterialIcons name="delete" size={22} color={C.error} />
                </TouchableOpacity>
                <MaterialIcons name="chevron-right" size={24} color={C.borderSub} />
              </View>
              <View style={s.eventDetails}>
                <Text style={s.eventTitle}>{linkedEvent.title}</Text>
                <View style={s.eventTimeRow}>
                  <MaterialIcons name="schedule" size={18} color={C.textSec} />
                  <Text style={s.eventTimeText}>
                    {formatEventDateTime(linkedEvent.start_time)}
                  </Text>
                </View>
                <View style={s.eventTimeRow}>
                  <MaterialIcons name="schedule" size={18} color={C.textSec} />
                  <Text style={s.eventTimeText}>
                    to {formatEventDateTime(linkedEvent.end_time)}
                  </Text>
                </View>
                {linkedEvent.location ? (
                  <View style={s.eventTimeRow}>
                    <MaterialIcons name="place" size={18} color={C.textSec} />
                    <Text style={s.eventTimeText} numberOfLines={1}>
                      {linkedEvent.location}
                    </Text>
                  </View>
                ) : null}
                {linkedEvent.reminder_minutes ? (
                  <View style={s.eventTimeRow}>
                    <MaterialIcons name="notifications" size={18} color={C.primary} />
                    <Text style={s.eventReminderText}>
                      Reminder: {formatReminderMinutes(linkedEvent.reminder_minutes)}
                    </Text>
                  </View>
                ) : null}
                {linkedEvent.description ? (
                  <Text style={s.eventDescription} numberOfLines={2}>
                    {linkedEvent.description}
                  </Text>
                ) : null}
              </View>
            </TouchableOpacity>
          ) : (
            <View style={s.calBtnRow}>
              <Button
                testID="schedule-event-btn"
                variant="box"
                layout="row"
                icon="calendar-today"
                label="Schedule New Event"
                onPress={() =>
                  router.push({
                    pathname: '/event-editor',
                    params: {
                      noteId: noteIdRef.current || 'new',
                      noteTitle: title,
                    },
                  })
                }
                style={s.calBtnBox}
              />
              <Button
                testID="link-event-btn"
                variant="box"
                layout="row"
                icon="link"
                label="Link Existing Event"
                onPress={openEventPicker}
                style={s.calBtnBox}
              />
            </View>
          )}

          <View style={{ height: 120 }} />
        </ScrollView>

        {/* Voice Input Bar + Format Toolbar */}
        <View style={s.bottomBar}>
          {/* Format Toolbar - drives the TenTap editor; shows while it's focused (disabled on web) */}
          {editorUi.isFocused && Platform.OS !== 'web' && (
            <View style={s.formatBar}>
              <TouchableOpacity
                testID="fmt-bold"
                style={[s.fmtBtn, editorUi.isBoldActive && s.fmtBtnActive]}
                onPress={() => editorApiRef.current?.toggleBold()}
              >
                <Text style={[s.fmtBold, editorUi.isBoldActive && s.fmtTextActive]}>B</Text>
                <Text style={[s.fmtLabel, editorUi.isBoldActive && s.fmtLabelActive]}>Bold</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="fmt-italic"
                style={[s.fmtBtn, editorUi.isItalicActive && s.fmtBtnActive]}
                onPress={() => editorApiRef.current?.toggleItalic()}
              >
                <Text style={[s.fmtItalic, editorUi.isItalicActive && s.fmtTextActive]}>I</Text>
                <Text style={[s.fmtLabel, editorUi.isItalicActive && s.fmtLabelActive]}>Italic</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="fmt-bullet"
                style={[s.fmtBtn, editorUi.isBulletListActive && s.fmtBtnActive]}
                onPress={() => editorApiRef.current?.toggleBulletList()}
              >
                <MaterialIcons name="format-list-bulleted" size={22} color={editorUi.isBulletListActive ? C.primary : C.text} />
                <Text style={[s.fmtLabel, editorUi.isBulletListActive && s.fmtLabelActive]}>List</Text>
              </TouchableOpacity>
            </View>
          )}
          
          {/* Action Buttons - Pin, Add Image, Share, Delete - shows when keyboard is hidden */}
          {!isKeyboardVisible && (
            <View style={s.actionBar}>
              <Button
                testID="pin-btn"
                variant="box"
                layout="stack"
                icon="push-pin"
                label={isPinned ? 'Pinned' : 'Pin'}
                active={isPinned}
                onPress={togglePin}
                style={s.actionBoxBtn}
              />
              <Button
                testID="add-image-btn"
                variant="box"
                layout="stack"
                icon="add-photo-alternate"
                label="Image"
                onPress={() => setShowImagePicker(true)}
                style={s.actionBoxBtn}
              />
              <Button
                testID="share-btn"
                variant="box"
                layout="stack"
                icon="share"
                label="Share"
                onPress={handleShare}
                style={s.actionBoxBtn}
              />
              {noteExists && (
                <Button
                  testID="delete-note-btn"
                  variant="box"
                  layout="stack"
                  tone="danger"
                  icon="delete"
                  label="Delete"
                  onPress={handleDelete}
                  style={s.actionBoxBtn}
                />
              )}
            </View>
          )}

          {/* Voice Input - hide when keyboard is visible */}
          {!isKeyboardVisible && (
            <View style={s.voiceBar}>
              {isTranscribing ? (
                <View style={s.transcribing}>
                  <ActivityIndicator size="small" color={C.primary} />
                  <Text style={s.transcribingText}>Converting speech to text...</Text>
                </View>
              ) : (
                <Button
                  testID="voice-input-btn"
                  variant="cta"
                  tone={isRecording ? 'danger' : 'default'}
                  icon={isRecording ? 'stop' : 'mic'}
                  label={isRecording ? 'Stop Recording' : 'Voice Input'}
                  onPress={isRecording ? stopRecording : startRecording}
                />
              )}
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
      
      {/* AI Processing Indicator */}
      {isProcessingText && (
        <View style={s.processingOverlay}>
          <View style={s.processingCard}>
            <ActivityIndicator size="large" color={C.primary} />
            <Text style={s.processingText}>AI is processing your text...</Text>
          </View>
        </View>
      )}
      
      {/* AI Suggestion Modal */}
      <Modal
        visible={showAiSuggestion}
        transparent
        animationType="fade"
        onRequestClose={() => handleAiProcess('keep')}
      >
        <View style={s.modalOverlay}>
          <View style={s.aiSuggestionCard}>
            <Text style={s.aiTitle}>Transcription Complete!</Text>
            <Text style={s.aiSubtitle}>Would you like AI to improve your text?</Text>
            
            <View style={s.aiPreview}>
              <Text style={s.aiPreviewText} numberOfLines={3}>
                "{transcribedText.substring(0, 150)}{transcribedText.length > 150 ? '...' : ''}"
              </Text>
            </View>
            
            <TouchableOpacity
              style={s.aiOption}
              onPress={() => handleAiProcess('organize')}
            >
              <MaterialIcons name="format-list-bulleted" size={24} color={C.secondary} />
              <View style={s.aiOptionText}>
                <Text style={s.aiOptionTitle}>Organize</Text>
                <Text style={s.aiOptionDesc}>Structure with paragraphs, bullets & headings</Text>
              </View>
            </TouchableOpacity>
            
            <TouchableOpacity
              style={s.aiOption}
              onPress={() => handleAiProcess('summarize')}
            >
              <MaterialIcons name="compress" size={24} color={C.secondary} />
              <View style={s.aiOptionText}>
                <Text style={s.aiOptionTitle}>Summarize</Text>
                <Text style={s.aiOptionDesc}>Condense into key points</Text>
              </View>
            </TouchableOpacity>
            
            <TouchableOpacity
              style={[s.aiOption, s.aiOptionKeep]}
              onPress={() => handleAiProcess('keep')}
            >
              <MaterialIcons name="check" size={24} color={C.textSec} />
              <View style={s.aiOptionText}>
                <Text style={[s.aiOptionTitle, { color: C.textSec }]}>Keep as is</Text>
                <Text style={s.aiOptionDesc}>Use the original transcription</Text>
              </View>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
      
      {/* Image Picker Modal */}
      <Modal
        visible={showImagePicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowImagePicker(false)}
      >
        <View style={s.modalOverlay}>
          <View style={s.imagePickerCard}>
            <Text style={s.imagePickerTitle}>Add Image</Text>
            
            <TouchableOpacity style={s.imagePickerOption} onPress={takePhoto}>
              <MaterialIcons name="camera-alt" size={28} color={C.primary} />
              <Text style={s.imagePickerOptionText}>Take Photo</Text>
            </TouchableOpacity>
            
            <TouchableOpacity style={s.imagePickerOption} onPress={pickFromGallery}>
              <MaterialIcons name="photo-library" size={28} color={C.secondary} />
              <Text style={s.imagePickerOptionText}>Choose from Gallery</Text>
            </TouchableOpacity>
            
            <TouchableOpacity 
              style={s.imagePickerCancel} 
              onPress={() => setShowImagePicker(false)}
            >
              <Text style={s.imagePickerCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Link Existing Event picker */}
      <Modal
        visible={showEventPicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowEventPicker(false)}
      >
        <View style={s.pickerOverlay}>
          <View style={s.pickerSheet}>
            <View style={s.pickerHeader}>
              <Text style={s.pickerTitle}>Link an Event</Text>
              <TouchableOpacity
                testID="close-event-picker"
                onPress={() => setShowEventPicker(false)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <MaterialIcons name="close" size={24} color={C.textSec} />
              </TouchableOpacity>
            </View>
            {loadingPickerEvents ? (
              <ActivityIndicator size="large" color={C.primary} style={{ marginVertical: 32 }} />
            ) : pickerEvents.length === 0 ? (
              <Text style={s.pickerEmpty}>No events yet. Use “Schedule New Event” to create one.</Text>
            ) : (
              <ScrollView style={{ maxHeight: 380 }}>
                {pickerEvents.map((ev) => (
                  <TouchableOpacity
                    key={ev.id}
                    testID={`pick-event-${ev.id}`}
                    style={s.pickerRow}
                    onPress={() => linkExistingEvent(ev)}
                    activeOpacity={0.7}
                  >
                    <MaterialIcons name="event" size={22} color={C.secondary} />
                    <View style={{ flex: 1, marginLeft: 10 }}>
                      <Text style={s.pickerRowTitle} numberOfLines={1}>{ev.title}</Text>
                      <Text style={s.pickerRowTime} numberOfLines={1}>
                        {formatEventDateTime(ev.start_time)}
                      </Text>
                    </View>
                    <MaterialIcons name="link" size={20} color={C.borderSub} />
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>

      {/* Delete Confirmation Modal - same look as the notes-list delete confirmation */}
      <Modal
        visible={showDeleteNoteModal}
        transparent
        animationType="fade"
        onRequestClose={cancelDeleteNote}
      >
        <View style={s.modalOverlay}>
          <View style={s.deleteModalContent}>
            <MaterialIcons name="delete" size={48} color={C.error} style={{ marginBottom: 16 }} />
            <Text style={s.deleteModalTitle}>Delete Note?</Text>
            <Text style={s.deleteModalMessage}>
              Are you sure you want to delete "{title || 'this note'}"? This action cannot be undone.
            </Text>
            <View style={s.deleteModalButtons}>
              <TouchableOpacity
                testID="cancel-delete-note-btn"
                style={s.deleteModalCancelBtn}
                onPress={cancelDeleteNote}
                activeOpacity={0.7}
              >
                <Text style={s.deleteModalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="confirm-delete-note-btn"
                style={s.deleteModalDeleteBtn}
                onPress={confirmDeleteNote}
                activeOpacity={0.7}
                disabled={deletingNote}
              >
                {deletingNote ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Text style={s.deleteModalDeleteText}>Delete</Text>
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
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: C.borderSub + '40',
  },
  headerTitle: { fontSize: 20, fontWeight: '700', color: C.text },
  headerBtn: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, height: 48 },
  headerBtnLabel: { fontSize: 18, fontWeight: '600', color: C.text, marginLeft: 4 },
  headerRight: { flexDirection: 'row', gap: 4 },
  statusBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 4, backgroundColor: C.surface,
  },
  statusText: { fontSize: 14, marginLeft: 4 },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 24, paddingTop: 16 },
  titleInput: {
    fontSize: 28, fontWeight: '700', color: C.text,
    paddingBottom: 12, marginBottom: 16,
  },
  tagsSection: { marginBottom: 16 },
  tagsRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  tagChip: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8,
    borderWidth: 1.5, marginRight: 8, marginBottom: 8,
  },
  tagChipText: { fontSize: 16, fontWeight: '600', marginRight: 4 },
  addTagBtn: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: radius.pill, borderWidth: 1.5, borderColor: C.border,
    marginBottom: 8,
  },
  addTagText: { fontSize: 16, fontWeight: '600', color: C.text, marginLeft: 4 },
  tagPicker: {
    backgroundColor: C.surface, borderRadius: 12, padding: 16,
    borderWidth: 2, borderColor: C.borderSub, marginTop: 8,
  },
  tagInput: {
    height: 48, borderWidth: 2, borderColor: C.border, borderRadius: 8,
    paddingHorizontal: 12, fontSize: 18, color: C.text, marginBottom: 12,
  },
  colorRow: { flexDirection: 'row', justifyContent: 'space-around', marginBottom: 12 },
  colorDot: { width: 40, height: 40, borderRadius: 20 },
  colorDotSel: { borderWidth: 3, borderColor: C.text },
  confirmTagBtn: {
    backgroundColor: C.primary, borderRadius: 12, height: 48,
    justifyContent: 'center', alignItems: 'center',
  },
  confirmTagText: { fontSize: 18, fontWeight: '600', color: C.primaryFg },
  contentContainer: {
    flex: 1,
    marginBottom: 16,
  },
  // The bordered box that visually contains both the shared-post card and the writing area.
  inputBox: {
    backgroundColor: C.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: C.border,
    paddingBottom: 4,
  },
  // The shared-post card nested inside the input box: inset from the border, small gap before text.
  cardInInput: {
    marginHorizontal: 10,
    marginTop: 10,
    marginBottom: 2,
  },
  // Insets the editor from the box border so the text has breathing room on all sides.
  richTextWrap: {
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 4,
  },
  // TenTap rich editor (WebView). FIXED height (not dynamicHeight) so the box is the same size from
  // the first frame - no resize glitch while the webview boots. Long notes scroll internally.
  // Opaque (surface-colored, matching the inputBox) - a transparent Android WebView stops repainting
  // after a parent re-render/blur (e.g. autosave), blanking the text until a tap forces a redraw.
  richText: {
    height: 180,
    backgroundColor: C.surface,
  },
  // Footer row inside the input box holding the attach-file button (below the WebView editor).
  editorFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingBottom: 8,
    paddingTop: 2,
  },
  attachInline: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.bg,
  },
  attachBtn: {
    position: 'absolute',
    left: 10,
    bottom: 10,
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.bg,
  },
  attachmentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  attachmentName: {
    flex: 1,
    fontSize: 15,
    color: C.text,
  },
  contentText: {
    fontSize: 18,
    color: C.text,
    lineHeight: 28,
  },
  boldText: {
    fontWeight: '700',
  },
  italicText: {
    fontStyle: 'italic',
  },
  // Rich Editor Styles
  richEditorContainer: {
    borderRadius: 12,
    borderWidth: 2,
    borderColor: C.borderSub,
    backgroundColor: C.surface,
    overflow: 'hidden',
    minHeight: 200,
  },
  richToolbar: {
    backgroundColor: C.bg,
    borderBottomWidth: 1,
    borderBottomColor: C.borderSub,
  },
  richEditor: {
    flex: 1,
    minHeight: 150,
  },
  // Web Editor Styles
  webFormatToolbar: {
    flexDirection: 'row',
    backgroundColor: C.bg,
    borderWidth: 2,
    borderBottomWidth: 1,
    borderColor: C.borderSub,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    padding: 8,
    gap: 8,
  },
  webFormatBtn: {
    padding: 8,
    borderRadius: 6,
    backgroundColor: C.surface,
  },
  webEditorContainer: {
    minHeight: 150,
    backgroundColor: C.surface,
    borderWidth: 2,
    borderTopWidth: 0,
    borderColor: C.borderSub,
    borderBottomLeftRadius: 12,
    borderBottomRightRadius: 12,
    padding: 16,
    fontSize: 18,
    lineHeight: 28,
  },
  calBtnRow: { flexDirection: 'row', gap: 10, marginTop: 16 },
  calBtnBox: { flex: 1 },
  // Event picker modal
  pickerOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  pickerSheet: {
    backgroundColor: C.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 20, paddingTop: 16, paddingBottom: 32,
  },
  pickerHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12,
  },
  pickerTitle: { fontSize: 20, fontWeight: '700', color: C.text },
  pickerEmpty: { fontSize: 16, color: C.textSec, textAlign: 'center', marginVertical: 32 },
  pickerRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: C.borderSub + '30',
  },
  pickerRowTitle: { fontSize: 16, fontWeight: '600', color: C.text },
  pickerRowTime: { fontSize: 13, color: C.textSec, marginTop: 2 },
  // Event Card Styles
  eventCard: {
    backgroundColor: C.surface, borderRadius: 12, padding: 16,
    borderWidth: 2, borderColor: C.secondary, marginTop: 16,
  },
  eventHeader: {
    flexDirection: 'row', alignItems: 'center', marginBottom: 12,
    paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: C.borderSub + '40',
  },
  eventHeaderText: {
    flex: 1, fontSize: 16, fontWeight: '600', color: C.secondary, marginLeft: 8,
  },
  eventDetails: {
    paddingLeft: 4,
  },
  eventTitle: {
    fontSize: 18, fontWeight: '700', color: C.text, marginBottom: 8,
  },
  eventTimeRow: {
    flexDirection: 'row', alignItems: 'center', marginBottom: 4,
  },
  eventTimeText: {
    fontSize: 15, color: C.textSec, marginLeft: 8,
  },
  eventReminderText: {
    fontSize: 15, color: C.primary, marginLeft: 8, fontWeight: '500',
  },
  eventDescription: {
    fontSize: 14, color: C.textSec, marginTop: 8, fontStyle: 'italic',
  },
  bottomBar: {
    borderTopWidth: 1, borderTopColor: C.borderSub + '40',
    backgroundColor: C.bg,
  },
  formatBar: {
    flexDirection: 'row', backgroundColor: C.surface,
    borderBottomWidth: 1, borderBottomColor: C.borderSub + '40',
  },
  fmtBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 10, gap: 4,
    borderRightWidth: 1, borderRightColor: C.borderSub + '20',
  },
  fmtBtnActive: {
    backgroundColor: C.primary,
  },
  fmtBold: { fontSize: 18, fontWeight: '900', color: C.text },
  fmtItalic: { fontSize: 18, fontStyle: 'italic', fontWeight: '600', color: C.text },
  fmtLabel: { fontSize: 14, color: C.textSec },
  fmtTextActive: { color: C.primaryFg },
  fmtLabelActive: { color: C.primaryFg },
  voiceBar: {
    paddingHorizontal: 24, paddingVertical: 12,
    backgroundColor: C.bg,
  },
  actionBar: {
    flexDirection: 'row',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 12,
    backgroundColor: C.bg,
    borderBottomWidth: 1,
    borderBottomColor: C.borderSub + '40',
  },
  actionBoxBtn: { flex: 1 },
  transcribing: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    height: 56,
  },
  transcribingText: { fontSize: 18, color: C.textSec, marginLeft: 12 },
  // AI Suggestion Modal Styles
  processingOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center', alignItems: 'center',
  },
  processingCard: {
    backgroundColor: C.surface,
    padding: 32,
    borderRadius: 16,
    alignItems: 'center',
  },
  processingText: {
    marginTop: 16, fontSize: 18, fontWeight: '600', color: C.text,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  deleteModalContent: {
    backgroundColor: C.surface,
    borderRadius: 20,
    padding: 24,
    width: '100%',
    maxWidth: 340,
    alignItems: 'center',
  },
  deleteModalTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: C.text,
    marginBottom: 12,
  },
  deleteModalMessage: {
    fontSize: 16,
    color: C.textSec,
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 24,
  },
  deleteModalButtons: {
    flexDirection: 'row',
    gap: 12,
    width: '100%',
  },
  deleteModalCancelBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: '#E0E0E0',
    alignItems: 'center',
  },
  deleteModalCancelText: {
    fontSize: 16,
    fontWeight: '600',
    color: C.text,
  },
  deleteModalDeleteBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: C.error,
    alignItems: 'center',
  },
  deleteModalDeleteText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  aiSuggestionCard: {
    backgroundColor: C.surface,
    borderRadius: 20,
    padding: 24,
    width: '100%',
    maxWidth: 400,
  },
  aiTitle: {
    fontSize: 24, fontWeight: '700', color: C.text, textAlign: 'center',
    marginBottom: 8,
  },
  aiSubtitle: {
    fontSize: 16, color: C.textSec, textAlign: 'center',
    marginBottom: 16,
  },
  aiPreview: {
    backgroundColor: C.bg,
    padding: 12,
    borderRadius: 12,
    marginBottom: 20,
  },
  aiPreviewText: {
    fontSize: 14, color: C.textSec, fontStyle: 'italic',
  },
  aiOption: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 12,
    backgroundColor: C.bg,
    marginBottom: 12,
    borderWidth: 2,
    borderColor: C.borderSub + '40',
  },
  aiOptionKeep: {
    backgroundColor: 'transparent',
    borderStyle: 'dashed',
  },
  aiOptionText: {
    marginLeft: 16, flex: 1,
  },
  aiOptionTitle: {
    fontSize: 18, fontWeight: '600', color: C.text,
  },
  aiOptionDesc: {
    fontSize: 14, color: C.textSec, marginTop: 2,
  },
  // Image Styles
  imagesContainer: {
    marginTop: 16,
    paddingHorizontal: 20,
  },
  imagesSectionTitle: {
    fontSize: 16, fontWeight: '600', color: C.text, marginBottom: 12,
  },
  imagesScroll: {
    flexDirection: 'row',
  },
  imageWrapper: {
    position: 'relative',
    marginRight: 12,
  },
  attachedImage: {
    width: 120,
    height: 120,
    borderRadius: 12,
    backgroundColor: C.borderSub + '20',
  },
  removeImageBtn: {
    position: 'absolute',
    top: -8,
    right: -8,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: C.error,
    justifyContent: 'center',
    alignItems: 'center',
  },
  addImageBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 20,
    marginTop: 16,
    padding: 16,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: C.borderSub + '40',
    borderStyle: 'dashed',
    backgroundColor: C.surface,
  },
  addImageBtnText: {
    fontSize: 16, fontWeight: '600', color: C.secondary, marginLeft: 8,
  },
  // Image Picker Modal
  imagePickerCard: {
    backgroundColor: C.surface,
    borderRadius: 20,
    padding: 24,
    width: '100%',
    maxWidth: 340,
  },
  imagePickerTitle: {
    fontSize: 22, fontWeight: '700', color: C.text, textAlign: 'center',
    marginBottom: 20,
  },
  imagePickerOption: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 12,
    backgroundColor: C.bg,
    marginBottom: 12,
  },
  imagePickerOptionText: {
    fontSize: 18, fontWeight: '600', color: C.text, marginLeft: 16,
  },
  imagePickerCancel: {
    alignItems: 'center',
    padding: 16,
    marginTop: 8,
  },
  imagePickerCancelText: {
    fontSize: 18, fontWeight: '600', color: C.textSec,
  },
});
