import React, { useState, useEffect, useRef, useCallback, useMemo, forwardRef, useImperativeHandle } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  ScrollView, KeyboardAvoidingView, Platform, Alert, ActivityIndicator,
  Keyboard, Share, Modal, Image, Animated, Easing,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { useAudioRecorder, AudioModule, RecordingPresets, setAudioModeAsync } from 'expo-audio';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as WebBrowser from 'expo-web-browser';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { notesApi, eventsApi, transcribeApi, textProcessApi, voiceIntentApi, attachmentsApi, uploadAttachmentWithProgress, type UploadFile } from '../src/api';
import { setPendingVoiceExtraction } from '../src/pendingVoiceEvents';
import { takePendingSketch } from '../src/pendingSketch';
import { decryptEventsFromServer } from '../src/crypto/eventCrypto';
import { RadialProgress, SharedPostCard, Button } from '../src/components';
import { decryptNoteFromServer } from '../src/crypto/noteCrypto';
import { createNoteOffline, updateNoteOffline, getLocalNotes, processSyncQueue } from '../src/offlineSync';
import { takePendingShareDraft, peekPendingShareDraft } from '../src/share/pendingShareDraft';
import { parseSourcePost, serializeSourcePost, type SourcePost } from '../src/share/socialSource';
import { unfurl, needsUnfurl } from '../src/share/unfurl';
import { plainTextFromContent } from '../src/textContent';
import { RichText, useEditorBridge, useEditorContent, useBridgeState, TenTapStartKit, PlaceholderBridge } from '@10play/tentap-editor';
import { TableBridge } from '../src/editor/tableBridge';
import { NotePlaceholderBridge } from '../src/editor/placeholderBridge';
import { customEditorHtml } from '../src/editor/customEditorHtml';
import { Tag, CalendarEvent, Attachment } from '../src/types';
import { TAG_COLORS, C, radius } from '../src/theme';
import { formatRecurrenceSummary } from '../src/recurrence';
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

// Caps the longest edge of a picked/captured photo before it's inlined as base64 into the note.
// ImagePicker's `quality: 0.7` only applies JPEG compression - it doesn't downscale pixel
// dimensions, so a modern phone camera can still produce a multi-MB base64 string regardless of
// that setting. 1600px is comfortably larger than any size a note image is ever displayed at in
// this app (card preview, editor inline), while cutting a typical 12MP+ photo down dramatically -
// that base64 blob is what gets synced to the server and rewritten into the local notes.json
// file on every autosave, so its size matters well beyond just this one image.
const MAX_NOTE_IMAGE_DIMENSION = 1600;

// Returns a resized+compressed base64 string, or null if resizing wasn't needed/failed - callers
// fall back to the picker's own base64 in either case, so a resize failure never blocks attaching
// the image, just skips the size optimization for that one image.
async function resizeImageForNote(uri: string, width: number, height: number): Promise<string | null> {
  const longestEdge = Math.max(width, height);
  // width/height can be 0 if the OS didn't report them (documented ImagePicker behavior) - can't
  // compute a target dimension without them, so skip resizing rather than guess.
  if (longestEdge <= 0 || longestEdge <= MAX_NOTE_IMAGE_DIMENSION) return null;

  const resize = width >= height ? { width: MAX_NOTE_IMAGE_DIMENSION } : { height: MAX_NOTE_IMAGE_DIMENSION };
  try {
    const result = await ImageManipulator.manipulateAsync(uri, [{ resize }], {
      compress: 0.7,
      format: ImageManipulator.SaveFormat.JPEG,
      base64: true,
    });
    return result.base64 ?? null;
  } catch (e) {
    console.warn('Note image resize failed, using original:', e);
    return null;
  }
}

// Imperative handle the parent uses to drive the editor (voice/AI insert + toolbar buttons).
type EditorApi = {
  getHTML: () => Promise<string>;
  setContent: (html: string) => void;
  toggleBold: () => void;
  toggleItalic: () => void;
  toggleBulletList: () => void;
  toggleTaskList: () => void;
  insertTable: () => void;
  addColumnAfter: () => void;
  addRowAfter: () => void;
  deleteColumn: () => void;
  deleteRow: () => void;
  deleteTable: () => void;
  undo: () => void;
  redo: () => void;
};
type EditorUiState = {
  isFocused: boolean; isBoldActive: boolean; isItalicActive: boolean; isBulletListActive: boolean;
  isTaskListActive: boolean; isTableActive: boolean;
  isReady: boolean; canUndo: boolean; canRedo: boolean;
};

// The TenTap rich-text body, isolated so the bridge is created with the note's content as
// `initialContent`. That's the reliable way to load existing content: `setContent` after mount
// races the webview's readiness (it logs "Editor isn't ready yet" and drops the call, leaving the
// body empty until tapped). Mounting this only once the content is known sidesteps the race.
// Writing-area height: TenTap's dynamicHeight is a no-op on Expo - node_modules/@10play/
// tentap-editor/src/webEditorUtils/contentHeight.tsx swaps in a shimmed, do-nothing
// ContentHeightListener whenever `expo-constants` is requireable (i.e. always, in this app),
// so the WebView's containerStyle height stays stuck at its initial 0 forever; nothing ever
// reports real content height back. So: grow the box from the content ourselves (bodyHeight
// below) instead. This also sidesteps the OTHER failure mode a flex/100%-based height hit - it
// got squeezed by sibling sections lower on the screen (attachments, linked events) competing
// for space in the same flex chain, clipping content behind the WebView's own internal scroll.
// bodyHeight is a plain pixel number, immune to both: it doesn't depend on the (broken)
// WebView resize signal, and it doesn't participate in flex distribution with its siblings.
const BODY_SANITY_MAX_HEIGHT = 20000;

function escapeHtml(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Drives a bottom sheet's backdrop fade + card slide together. Opening decelerates in
// (Easing.out) for a soft landing; closing accelerates away (Easing.in) so the dismiss feels
// snappy rather than lingering. Matched durations keep the fade and slide finishing in sync.
function animateSheet(backdrop: Animated.Value, translateY: Animated.Value, open: boolean): void {
  const duration = open ? 280 : 220;
  const easing = open ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic);
  Animated.parallel([
    Animated.timing(backdrop, { toValue: open ? 1 : 0, duration, easing, useNativeDriver: true }),
    Animated.timing(translateY, { toValue: open ? 0 : 400, duration, easing, useNativeDriver: true }),
  ]).start();
}

// Same default extension set TenTap ships (bold/lists/links/etc.), with the stock
// PlaceholderBridge swapped for NotePlaceholderBridge - the stock one (plain string, unconfigured
// here) shows its ghost text on any empty node the cursor sits in, including a freshly-toggled
// checklist's empty item, not just a blank note. See src/editor/placeholderBridgeConfig.ts.
const noteBridgeExtensions = [
  ...TenTapStartKit.filter((ext) => ext !== PlaceholderBridge),
  TableBridge,
  NotePlaceholderBridge,
];

const NoteBodyEditor = forwardRef<EditorApi, {
  initialContent: string;
  onChange: (html: string) => void;
  onStateChange: (s: EditorUiState) => void;
}>(function NoteBodyEditor({ initialContent, onChange, onStateChange }, ref) {
  const editor = useEditorBridge({
    autofocus: false,
    avoidIosKeyboard: true,
    initialContent,
    bridgeExtensions: noteBridgeExtensions,
    // The default bundled web editor only knows TenTapStartKit's own built-in bridges - it has
    // no idea TableBridge (a custom extension, see src/editor/tableBridge.ts) exists, so
    // `insertTable()` etc. would silently no-op without this. customEditorHtml is our own build
    // of the web-side editor (webEditor/) that includes it too - see
    // scripts/buildWebEditorHtml.js; re-run `npm run build:web-editor` after editing tableBridge.ts.
    customSource: customEditorHtml,
  });
  const state = useBridgeState(editor);
  const html = useEditorContent(editor, { type: 'html', debounceInterval: 400 });

  // state.isReady is NOT a boot signal despite the name - TenTap's core bridge hardcodes it to
  // `true` inside every StateUpdate payload (node_modules/@10play/tentap-editor/.../bridges/
  // core.js extendEditorState), and StateUpdate only ever fires from onTransaction/
  // onSelectionUpdate inside the webview - i.e. only after the user has already interacted with
  // the editor. A note the user never taps into (e.g. a share appended in the background) would
  // report not-ready forever. The webview DOES post an unconditional 'editor-ready' message on
  // its own onCreate, independent of interaction - that's the real boot signal, so intercept it
  // directly via RichText's onMessage instead of trusting state.isReady.
  const [bridgeReady, setBridgeReady] = useState(false);
  const handleWebviewMessage = useCallback((event: { nativeEvent: { data: string } }) => {
    try {
      const { type } = JSON.parse(event.nativeEvent.data);
      if (type === 'editor-ready') setBridgeReady(true);
    } catch {}
  }, []);
  // The page can settle scrolled a few px past the top once fonts/layout finish reflowing after
  // `initialContent` loads, clipping the first line of imported/shared text. Runs once, right as
  // the freshly-mounted editor reports ready.
  useEffect(() => {
    if (!bridgeReady) return;
    const t = setTimeout(() => {
      editor.webviewRef.current?.injectJavaScript('window.scrollTo(0, 0); true;');
    }, 100);
    return () => clearTimeout(t);
  }, [bridgeReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // Estimate the writing-area height from the content (dynamicHeight can't do this - see the
  // note above) so a long paste (e.g. text copied from a webpage) grows the box to show all of
  // it, instead of clipping it behind the WebView's internal scroll. No real max - BODY_SANITY_MAX
  // is only a backstop against a degenerate estimate.
  const bodyHeight = useMemo(() => {
    const h = html || initialContent || '';
    const blocks = (h.match(/<\/(p|div|h[1-6]|li|blockquote)>|<br\s*\/?>/gi) || []).length;
    const text = h.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ');
    const wrapped = Math.ceil((text.trim().length || 1) / 36); // ~36 chars/line at the editor width
    const lines = Math.max(blocks + 1, wrapped);
    return Math.min(BODY_SANITY_MAX_HEIGHT, lines * 26 + 28);
  }, [html, initialContent]);

  useImperativeHandle(ref, () => ({
    getHTML: () => editor.getHTML(),
    setContent: (h: string) => editor.setContent(h),
    toggleBold: () => editor.toggleBold(),
    toggleItalic: () => editor.toggleItalic(),
    toggleBulletList: () => editor.toggleBulletList(),
    toggleTaskList: () => editor.toggleTaskList(),
    insertTable: () => editor.insertTable(),
    addColumnAfter: () => editor.addColumnAfter(),
    addRowAfter: () => editor.addRowAfter(),
    deleteColumn: () => editor.deleteColumn(),
    deleteRow: () => editor.deleteRow(),
    deleteTable: () => editor.deleteTable(),
    undo: () => editor.undo(),
    redo: () => editor.redo(),
  }), [editor]);

  useEffect(() => { if (html != null) onChange(html); }, [html]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    onStateChange({
      isFocused: state.isFocused,
      isBoldActive: state.isBoldActive,
      isItalicActive: state.isItalicActive,
      isBulletListActive: state.isBulletListActive,
      isTaskListActive: state.isTaskListActive,
      isTableActive: state.isTableActive,
      isReady: bridgeReady,
      canUndo: state.canUndo,
      canRedo: state.canRedo,
    });
  }, [state.isFocused, state.isBoldActive, state.isItalicActive, state.isBulletListActive, state.isTaskListActive, state.isTableActive, state.canUndo, state.canRedo, bridgeReady]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View style={s.richTextWrap}>
      <RichText
        editor={editor}
        style={[s.richText, { height: bodyHeight }]}
        scrollEnabled
        onMessage={handleWebviewMessage}
        exclusivelyUseCustomOnMessage={false}
      />
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
  const [linkedEventIds, setLinkedEventIds] = useState<string[]>([]);
  const [linkedEvents, setLinkedEvents] = useState<CalendarEvent[]>([]);
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
  // Driven manually (Modal's animationType="none") so the backdrop fades while the sheet slides.
  const imagePickerBackdrop = useRef(new Animated.Value(0)).current;
  const imagePickerTranslateY = useRef(new Animated.Value(400)).current;
  const eventPickerBackdrop = useRef(new Animated.Value(0)).current;
  const eventPickerTranslateY = useRef(new Animated.Value(400)).current;
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
  // TenTap's own focus-tracking (editorUi.isFocused, driven by the WebView bridge) is permanently
  // stuck false on Expo - its web-side focusListener module is hard-stubbed to `{ isFocused: false }`
  // there to dodge a `document`-undefined crash (see node_modules/@10play/tentap-editor/src/
  // webEditorUtils/focusListener.tsx). So the format bar can never use it to decide visibility.
  // Track focus on the two plain TextInputs instead (title, tag name) and infer "the rich-text
  // editor has focus" as "keyboard is up but neither of those does" - together they're the only
  // three focusable fields on this screen.
  const [plainInputFocused, setPlainInputFocused] = useState(false);
  const titleInputRef = useRef<TextInput>(null);
  // Rich-text editor (TenTap). Content is the note body HTML; `contentRef` holds the latest for
  // saving. The editor lives in <NoteBodyEditor>, mounted with the loaded content as initialContent
  // (below). We drive it imperatively via editorApiRef and mirror its UI state for the toolbar.
  const editorApiRef = useRef<EditorApi | null>(null);
  const [editorUi, setEditorUi] = useState<EditorUiState>({
    isFocused: false, isBoldActive: false, isItalicActive: false, isBulletListActive: false, isTaskListActive: false,
    isTableActive: false,
    isReady: false, canUndo: false, canRedo: false,
  });
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
  const linkedEventIdsRef = useRef<string[]>(linkedEventIds);
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
  useEffect(() => { linkedEventIdsRef.current = linkedEventIds; }, [linkedEventIds]);
  useEffect(() => { imagesRef.current = images; }, [images]);
  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);
  useEffect(() => { sourcePostRef.current = sourcePost; }, [sourcePost]);
  useEffect(() => { thumbInImages0Ref.current = thumbInImages0; }, [thumbInImages0]);
  useEffect(() => {
    animateSheet(imagePickerBackdrop, imagePickerTranslateY, showImagePicker);
  }, [showImagePicker, imagePickerBackdrop, imagePickerTranslateY]);
  useEffect(() => {
    animateSheet(eventPickerBackdrop, eventPickerTranslateY, showEventPicker);
  }, [showEventPicker, eventPickerBackdrop, eventPickerTranslateY]);

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

  // Append a shared draft into an EXISTING note (chosen via the share-target picker) instead of
  // overwriting it. Gated on both the note finishing its load AND the WebView bridge reporting
  // ready (editorUi.isReady) - calling setContent before the bridge is ready silently drops (see
  // NoteBodyEditor's initialContent comment above), so a plain "note loaded" check isn't enough.
  const sharedAppendedRef = useRef(false);
  useEffect(() => {
    if (isNew || shared !== '1' || loading || !editorUi.isReady || sharedAppendedRef.current) return;
    const draft = peekPendingShareDraft();
    if (!draft) return;
    sharedAppendedRef.current = true;
    takePendingShareDraft(); // now that we're committed to applying it
    isSharedRef.current = true;
    userEditedRef.current = true;

    (async () => {
      // A note can only carry one source-post card (single trailing marker) - if this note
      // already has one, fold the incoming link into the body as a plain paragraph instead of
      // dropping it.
      const hadCard = !!sourcePostRef.current;
      let extraHtml = draft.content || '';
      if (draft.sourcePost) {
        if (!hadCard) {
          setSourcePost(draft.sourcePost);
          setThumbInImages0(!!draft.sourcePost.thumbnail);
        } else {
          const label = escapeHtml(draft.sourcePost.title || draft.sourcePost.url);
          extraHtml += `<p><a href="${draft.sourcePost.url}">${label}</a></p>`;
        }
      }
      if (extraHtml) {
        let current = '';
        try { current = (await editorApiRef.current?.getHTML()) || ''; } catch {}
        const base = current.replace(/<p><\/p>\s*$/i, ''); // drop a trailing empty paragraph
        editorApiRef.current?.setContent(base + extraHtml);
      }

      if (draft.images?.length) {
        // A fresh card's thumbnail must land at images[0] (the persisted-marker convention) -
        // prepend when we just adopted the card; otherwise append after any existing images.
        const adoptedCardThumb = !hadCard && !!draft.sourcePost?.thumbnail;
        setImages(prev => (adoptedCardThumb ? [...draft.images, ...prev] : [...prev, ...draft.images]));
      }
      if (draft.tags?.length) {
        setTags(prev => {
          const have = new Set(prev.map(t => t.name));
          const extra = (draft.tags as Tag[]).filter(t => !have.has(t.name));
          return extra.length ? [...prev, ...extra] : prev;
        });
      }
      // Big shared files upload here (in the editor) with visible radial progress.
      if (draft.pendingFiles?.length) uploadFiles(draft.pendingFiles);
      triggerAutoSave();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, shared, loading, editorUi.isReady]);

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
        // Same local-first treatment for the rest of the note - title/tags/pin/images visibly
        // lagging a beat behind the instantly-seeded body (while the network reconcile below is
        // still in flight) reads as a bug even though the data was already sitting in storage.
        // The reconcile block further down re-sets all of these once the server copy resolves,
        // so this is just removing the wait, not skipping the sync.
        setTitle(localCopy.title);
        setTags(localCopy.tags);
        setIsPinned(localCopy.is_pinned);
        setImages(localCopy.images || []);
        setAttachments(localCopy.attachments || []);
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
      // Defensive fallback: prefer the plural field, but fall back to the deprecated singular one
      // in case a transitional/cached copy only has that populated (the server already normalizes
      // and dual-writes both, so this is belt-and-suspenders, not the expected path).
      const ids: string[] = note.linked_event_ids?.length
        ? note.linked_event_ids
        : (note.linked_event_id ? [note.linked_event_id] : []);
      setLinkedEventIds(ids);
      setImages(note.images || []);
      setAttachments(note.attachments || []);
      noteIdRef.current = note.id;
      isCreatedRef.current = true;
      setNoteExists(true);

      // Fetch linked event details if any, in a single batch request.
      if (ids.length > 0) {
        try {
          const events = await decryptEventsFromServer<CalendarEvent>(await eventsApi.getBatch(ids));
          setLinkedEvents(events);
        } catch (e) {
          console.error('Failed to load linked events:', e);
        }
      }
    } catch (e) {
      console.error('Failed to load note:', e);
    } finally {
      setLoading(false);
    }
  };

  // Fetch any linked events not yet resolved (e.g. right after linkedEventIds changes but before
  // the setter that pairs it with linkedEvents has run) and drop any resolved events no longer
  // linked. A defensive backstop - every path that changes linkedEventIds also sets/merges
  // linkedEvents itself, but this keeps the two arrays from drifting out of sync.
  useEffect(() => {
    if (linkedEventIds.length === 0) {
      setLinkedEvents(prev => (prev.length ? [] : prev));
      return;
    }
    setLinkedEvents(prev => {
      const stale = prev.some(ev => !linkedEventIds.includes(ev.id));
      return stale ? prev.filter(ev => linkedEventIds.includes(ev.id)) : prev;
    });
    const missingIds = linkedEventIds.filter(id => !linkedEvents.some(ev => ev.id === id));
    if (missingIds.length === 0) return;
    eventsApi.getBatch(missingIds)
      .then(decryptEventsFromServer<CalendarEvent>)
      .then(fetched => setLinkedEvents(prev => [...prev.filter(ev => linkedEventIds.includes(ev.id)), ...fetched]))
      .catch(e => console.error('Failed to load event:', e));
    // `linkedEvents` intentionally excluded from deps below: this effect only needs to react to
    // `linkedEventIds` changing, and reads the current `linkedEvents` value each run via closure -
    // adding it as a dep would re-run on every fetch this effect itself triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedEventIds]);

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
            if (!linkedEventIdsRef.current.includes(pendingEventId)) {
              trackNoteEventScheduled();
            }
            // Append the newly scheduled event id (never replace - a note can carry many).
            const nextIds = Array.from(new Set([...linkedEventIdsRef.current, pendingEventId]));
            setLinkedEventIds(nextIds);
            // Fetch all linked events' details in one batch.
            const events = await decryptEventsFromServer<CalendarEvent>(await eventsApi.getBatch(nextIds));
            setLinkedEvents(events);
            return;
          }
        } catch (e) {
          console.error('Error checking pending event:', e);
        }

        // If we have a synced note, reload it to get the latest linked_event_ids.
        // Skip for not-yet-synced local notes (no server row yet → would 404).
        if (noteIdRef.current && isCreatedRef.current && !noteIdRef.current.startsWith('local_')) {
          try {
            const note = await notesApi.get(noteIdRef.current);
            const ids: string[] = note.linked_event_ids?.length
              ? note.linked_event_ids
              : (note.linked_event_id ? [note.linked_event_id] : []);
            if (ids.length > 0) {
              // Track event scheduling if any new linked event id showed up
              if (ids.some((id: string) => !linkedEventIdsRef.current.includes(id))) {
                trackNoteEventScheduled();
              }
              setLinkedEventIds(ids);
              // Fetch all linked events' details in one batch.
              const events = await decryptEventsFromServer<CalendarEvent>(await eventsApi.getBatch(ids));
              setLinkedEvents(events);
            } else if (linkedEventIdsRef.current.length > 0) {
              setLinkedEventIds([]);
              setLinkedEvents([]);
            }
          } catch (e) {
            console.error('Failed to refresh note data:', e);
          }
        } else if (linkedEventIdsRef.current.length > 0) {
          // Just refresh events if we already have linkedEventIds
          try {
            const events = await decryptEventsFromServer<CalendarEvent>(await eventsApi.getBatch(linkedEventIdsRef.current));
            setLinkedEvents(events);
          } catch (e) {
            console.error('Failed to refresh event:', e);
          }
        }
      };
      
      refreshData();
      // linkedEventIds isn't read directly in the body above (linkedEventIdsRef.current is,
      // which is always fresh) - deps intentionally empty so this doesn't re-register every time
      // the array changes.
    }, [])
  );

  // Pick up a sketch staged by /sketch (see pendingSketch.ts) once this screen regains focus -
  // same "can't fit in route params" handoff pattern the share-intent draft and voice-event
  // extraction already use. Same three-step sequence takePhoto/pickFromGallery use to attach an
  // image: append to images, track it, autosave.
  useFocusEffect(
    useCallback(() => {
      const dataUri = takePendingSketch();
      if (dataUri) {
        const newImages = [...imagesRef.current, dataUri];
        setImages(newImages);
        trackNoteImageAttached(newImages.length);
        triggerAutoSave();
      }
    }, []) // eslint-disable-line react-hooks/exhaustive-deps
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
      // linked_event_ids is authoritative; linked_event_id (deprecated, singular) rides along
      // dual-written for any not-yet-updated client/cache that only reads the old field.
      linked_event_id: linkedEventIdsRef.current[0] ?? null,
      linked_event_ids: linkedEventIdsRef.current,
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
        has_scheduled_event: linkedEventIdsRef.current.length > 0,
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
      const hasContent = !!(titleRef.current || contentRef.current || linkedEventIdsRef.current.length > 0 || imagesRef.current.length > 0 || attachmentsRef.current.length > 0 || sourcePostRef.current);
      // Persist locally; only create a brand-new note if it actually has content.
      if (isCreatedRef.current ? !!noteIdRef.current : hasContent) {
        // Local-only and awaited (fast, always succeeds offline) - `push: true` here used to
        // await a full network round-trip before back navigation could even start, making every
        // "edit a note, tap back" visibly hang on the network. The queue flush below already
        // covers reaching the server; it just needs to not block the tap that triggered it.
        await persistLocal({ push: false });
        // Flush the queue so the note reaches the server on exit (best-effort, non-blocking).
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
    if (!title && !plainContent && linkedEvents.length === 0) {
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

    // Add linked event details with an Event header - one block per linked event (numbered
    // when there's more than one, so multiple reminders don't blur together in the share text).
    linkedEvents.forEach((ev, i) => {
      shareText += `\n📅 Event${linkedEvents.length > 1 ? ` ${i + 1}` : ''}\n\n`;
      shareText += `Title: ${ev.title}\n`;
      shareText += `Start: ${formatEventDateTime(ev.start_time)}\n`;
      shareText += `End: ${formatEventDateTime(ev.end_time)}\n`;
      if (ev.location) {
        shareText += `Location: ${ev.location}\n`;
      }
      if (ev.reminder_minutes) {
        shareText += `Reminder: ${formatReminderMinutes(ev.reminder_minutes)}\n`;
      }
      const recurrenceSummary = formatRecurrenceSummary(ev.recurrence);
      if (recurrenceSummary) {
        shareText += `${recurrenceSummary}\n`;
      }
      if (ev.description) {
        shareText += `Description: ${ev.description}\n`;
      }
    });

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
      setTranscribedText(result.text);

      // Before offering the usual dictation flow, ask whether this transcript is actually a
      // scheduling request ("Set a reminder to take medication every Monday", "Plan my Tokyo
      // trip: flight Friday...") - if so, hand off to the voice-event confirm screen instead of
      // inserting the words into the note. A classification failure (network hiccup, etc.) must
      // never block ordinary dictation, so it just falls through to the existing flow below.
      if (result.text.trim()) {
        try {
          const referenceDate = new Date().toISOString().slice(0, 10); // device's local "today"
          const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
          const classification = await voiceIntentApi.classify(result.text, referenceDate, timezone);
          if (classification.intent !== 'note' && classification.events.length > 0) {
            setIsTranscribing(false);
            setPendingVoiceExtraction({ transcript: result.text, ...classification });
            router.push('/voice-event');
            return;
          }
        } catch (e) {
          console.error('Voice intent classification failed, falling back to dictation:', e);
        }
      }

      // Show AI suggestion modal for ordinary dictation
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
      const asset = result.assets[0];
      // Downscale before inlining if the capture is larger than a note image ever needs to be -
      // see resizeImageForNote's comment. Falls back to the picker's own base64 if resizing
      // wasn't needed or failed.
      const resized = await resizeImageForNote(asset.uri, asset.width, asset.height);
      const base64Data = resized ?? asset.base64;
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
      // Downscale each asset before inlining, same as takePhoto - see resizeImageForNote.
      const newImageUris = (
        await Promise.all(
          result.assets.map(async (asset) => {
            const resized = await resizeImageForNote(asset.uri, asset.width, asset.height);
            const base64Data = resized ?? asset.base64;
            return base64Data ? `data:image/jpeg;base64,${base64Data}` : null;
          })
        )
      ).filter((uri): uri is string => uri !== null);
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

  // Tap a linked-event card's delete control -> choose to unlink or fully delete just that event.
  const handleRemoveLinkedEvent = (eventId: string) => {
    const event = linkedEvents.find(ev => ev.id === eventId);
    if (!event) return;
    const remainingIds = linkedEventIds.filter(id => id !== eventId);

    // Persist the cleared link to the server BEFORE updating local state. The
    // focus refresh re-reads the note on every focus/linkedEventIds change, so
    // relying on the debounced autosave would race it and re-link the event
    // from the still-stale server value.
    const clearLinkOnServer = async () => {
      if (noteIdRef.current && isCreatedRef.current) {
        await updateNoteOffline(noteIdRef.current, {
          linked_event_ids: remainingIds,
          linked_event_id: remainingIds[0] ?? null,
        });
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
            setLinkedEventIds(remainingIds);
            setLinkedEvents(prev => prev.filter(ev => ev.id !== eventId));
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
            setLinkedEventIds(remainingIds);
            setLinkedEvents(prev => prev.filter(ev => ev.id !== eventId));
          },
        },
      ],
    );
  };

  // Open a picker of existing events to link to this note. Already-linked events are excluded -
  // linking is additive now, but the same event still shouldn't be linkable twice.
  const openEventPicker = async () => {
    setShowEventPicker(true);
    setLoadingPickerEvents(true);
    try {
      const events = await decryptEventsFromServer<CalendarEvent>(await eventsApi.getAll());
      setPickerEvents(events.filter(ev => !linkedEventIds.includes(ev.id)));
    } catch (e) {
      console.error('Load events for picker failed:', e);
      setPickerEvents([]);
    } finally {
      setLoadingPickerEvents(false);
    }
  };

  // Append (never replace) a linked event picked from the existing-events list.
  const linkExistingEvent = async (event: CalendarEvent) => {
    setShowEventPicker(false);
    setLinkedEventIds(prev => (prev.includes(event.id) ? prev : [...prev, event.id]));
    setLinkedEvents(prev => (prev.some(ev => ev.id === event.id) ? prev : [...prev, event]));
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
    if (!title.trim() && !plainTextFromContent(contentRef.current) && linkedEventIdsRef.current.length === 0
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

  // New note: cursor lands in the Title field right away, so typing can start immediately without
  // an extra tap. Delayed slightly to clear the screen's push-in transition - focusing before it
  // settles gets silently dropped on Android.
  useEffect(() => {
    if (!isNew) return;
    const t = setTimeout(() => titleInputRef.current?.focus(), 300);
    return () => clearTimeout(t);
  }, [isNew]);

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
            ref={titleInputRef}
            testID="note-title-input"
            style={s.titleInput}
            placeholder="Note title..."
            placeholderTextColor={C.borderSub}
            value={title}
            onChangeText={handleTitleChange}
            onFocus={() => setPlainInputFocused(true)}
            onBlur={() => setPlainInputFocused(false)}
            returnKeyType="next"
            multiline
          />

          {/* Tag chips + picker */}
          {(tags.length > 0 || showTagPicker) && (
            <View style={s.tagsSection}>
              {tags.length > 0 && (
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
                </View>
              )}

              {showTagPicker && (
                <View style={s.tagPicker}>
                  <View style={s.tagPickerHeader}>
                    <Text style={s.tagPickerTitle}>Add Tag</Text>
                    <TouchableOpacity
                      testID="close-tag-picker-btn"
                      onPress={() => setShowTagPicker(false)}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    >
                      <MaterialIcons name="close" size={22} color={C.textSec} />
                    </TouchableOpacity>
                  </View>
                  <TextInput
                    testID="tag-name-input"
                    style={s.tagInput}
                    placeholder="Tag name..."
                    placeholderTextColor={C.borderSub}
                    value={newTagName}
                    onChangeText={setNewTagName}
                    onFocus={() => setPlainInputFocused(true)}
                    onBlur={() => setPlainInputFocused(false)}
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
                  <Button testID="confirm-tag-btn" variant="outline" label="Add Tag" onPress={addTag} style={s.confirmTagBtn} />
                </View>
              )}
            </View>
          )}

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

              {/* Attachments - shown inside the writing surface itself, not as a separate section
                  below it. */}
              {(attachments.length > 0 || pendingUploads.length > 0) && (
                <View style={s.imagesContainerInBox}>
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

              {/* Images (the card's thumbnail lives at images[0] and is shown by the card, not here) -
                  same in-box placement as Attachments above. */}
              {images.filter((_, i) => !(thumbInImages0 && i === 0)).length > 0 && (
                <View style={s.imagesContainerInBox}>
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

              {/* Calendar Links / Event Details - a note can carry any number of linked events
                  now, each rendered as its own card (was capped at one). Rendered inside the
                  writing surface, below the body text and below Attachments/Images when either
                  is present. */}
              {linkedEvents.map((ev) => (
                <TouchableOpacity
                  key={ev.id}
                  testID={`linked-event-card-${ev.id}`}
                  style={s.eventCardInBox}
                  onPress={() =>
                    router.push({
                      pathname: '/event-editor',
                      params: {
                        eventId: ev.id,
                        noteId: noteIdRef.current || 'new',
                      },
                    })
                  }
                >
                  <View style={s.eventHeader}>
                    <MaterialIcons name="event" size={24} color={C.secondary} />
                    <Text style={s.eventHeaderText}>Linked Event</Text>
                    <TouchableOpacity
                      testID={`remove-linked-event-btn-${ev.id}`}
                      onPress={() => handleRemoveLinkedEvent(ev.id)}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      style={{ paddingHorizontal: 4 }}
                    >
                      <MaterialIcons name="delete" size={22} color={C.error} />
                    </TouchableOpacity>
                    <MaterialIcons name="chevron-right" size={24} color={C.borderSub} />
                  </View>
                  <View style={s.eventDetails}>
                    <Text style={s.eventTitle}>{ev.title}</Text>
                    <View style={s.eventTimeRow}>
                      <MaterialIcons name="schedule" size={18} color={C.textSec} />
                      <Text style={s.eventTimeText}>
                        {formatEventDateTime(ev.start_time)}
                      </Text>
                    </View>
                    <View style={s.eventTimeRow}>
                      <MaterialIcons name="schedule" size={18} color={C.textSec} />
                      <Text style={s.eventTimeText}>
                        to {formatEventDateTime(ev.end_time)}
                      </Text>
                    </View>
                    {ev.location ? (
                      <View style={s.eventTimeRow}>
                        <MaterialIcons name="place" size={18} color={C.textSec} />
                        <Text style={s.eventTimeText} numberOfLines={1}>
                          {ev.location}
                        </Text>
                      </View>
                    ) : null}
                    {ev.reminder_minutes ? (
                      <View style={s.eventTimeRow}>
                        <MaterialIcons name="notifications" size={18} color={C.primary} />
                        <Text style={s.eventReminderText}>
                          Reminder: {formatReminderMinutes(ev.reminder_minutes)}
                        </Text>
                      </View>
                    ) : null}
                    {formatRecurrenceSummary(ev.recurrence) ? (
                      <View style={s.eventTimeRow}>
                        <MaterialIcons name="repeat" size={18} color={C.primary} />
                        <Text style={s.eventReminderText}>
                          {formatRecurrenceSummary(ev.recurrence)}
                        </Text>
                      </View>
                    ) : null}
                    {ev.description ? (
                      <Text style={s.eventDescription} numberOfLines={2}>
                        {ev.description}
                      </Text>
                    ) : null}
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <View style={{ height: 120 }} />
        </ScrollView>

        {/* Voice Input Bar + Format Toolbar */}
        <View style={s.bottomBar}>
          {/* Format Toolbar - drives the TenTap editor; shows while it's focused (disabled on web).
              editorUi.isFocused is unusable here (see plainInputFocused's declaration for why) -
              keyboard-visible-but-not-a-plain-input is the reliable signal instead. */}
          {isKeyboardVisible && !plainInputFocused && Platform.OS !== 'web' && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={s.formatBar}
              contentContainerStyle={s.formatBarContent}
            >
              <TouchableOpacity
                testID="fmt-bold"
                style={[s.fmtBtn, editorUi.isBoldActive && s.fmtBtnActive]}
                onPress={() => editorApiRef.current?.toggleBold()}
              >
                <MaterialIcons name="format-bold" size={24} color={editorUi.isBoldActive ? C.primaryFg : C.text} />
              </TouchableOpacity>
              <TouchableOpacity
                testID="fmt-italic"
                style={[s.fmtBtn, editorUi.isItalicActive && s.fmtBtnActive]}
                onPress={() => editorApiRef.current?.toggleItalic()}
              >
                <MaterialIcons name="format-italic" size={24} color={editorUi.isItalicActive ? C.primaryFg : C.text} />
              </TouchableOpacity>
              <TouchableOpacity
                testID="fmt-bullet"
                style={[s.fmtBtn, editorUi.isBulletListActive && s.fmtBtnActive]}
                onPress={() => editorApiRef.current?.toggleBulletList()}
              >
                <MaterialIcons name="format-list-bulleted" size={24} color={editorUi.isBulletListActive ? C.primaryFg : C.text} />
              </TouchableOpacity>
              <TouchableOpacity
                testID="fmt-checklist"
                style={[s.fmtBtn, editorUi.isTaskListActive && s.fmtBtnActive]}
                onPress={() => editorApiRef.current?.toggleTaskList()}
              >
                <MaterialIcons name="checklist" size={24} color={editorUi.isTaskListActive ? C.primaryFg : C.text} />
              </TouchableOpacity>
              <TouchableOpacity
                testID="fmt-table"
                style={[s.fmtBtn, editorUi.isTableActive && s.fmtBtnActive]}
                onPress={() => editorApiRef.current?.insertTable()}
              >
                <MaterialIcons name="table-chart" size={24} color={editorUi.isTableActive ? C.primaryFg : C.text} />
              </TouchableOpacity>
              <TouchableOpacity
                testID="fmt-draw"
                style={s.fmtBtn}
                onPress={() => router.push('/sketch')}
              >
                <MaterialIcons name="draw" size={24} color={C.text} />
              </TouchableOpacity>
              <TouchableOpacity
                testID="fmt-undo"
                style={[s.fmtBtn, !editorUi.canUndo && s.fmtBtnDisabled]}
                onPress={() => editorApiRef.current?.undo()}
                disabled={!editorUi.canUndo}
              >
                <MaterialIcons name="undo" size={24} color={C.text} />
              </TouchableOpacity>
              <TouchableOpacity
                testID="fmt-redo"
                style={[s.fmtBtn, !editorUi.canRedo && s.fmtBtnDisabled]}
                onPress={() => editorApiRef.current?.redo()}
                disabled={!editorUi.canRedo}
              >
                <MaterialIcons name="redo" size={24} color={C.text} />
              </TouchableOpacity>
            </ScrollView>
          )}

          {/* Table row/column controls - only meaningful with the cursor inside a table, so
              there's no other affordance for these once the "Table" button above has inserted
              one. Horizontally scrollable (unlike the fixed-width format bar above) since these
              are supplementary and don't need to all be visible without scrolling. */}
          {isKeyboardVisible && !plainInputFocused && editorUi.isTableActive && Platform.OS !== 'web' && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={s.tableControlsBar}
              contentContainerStyle={s.tableControlsBarContent}
            >
              <TouchableOpacity testID="fmt-table-add-row" style={s.tableCtrlBtn} onPress={() => editorApiRef.current?.addRowAfter()}>
                <MaterialIcons name="table-rows" size={20} color={C.text} />
                <Text style={s.tableCtrlLabel}>Add Row</Text>
              </TouchableOpacity>
              <TouchableOpacity testID="fmt-table-add-col" style={s.tableCtrlBtn} onPress={() => editorApiRef.current?.addColumnAfter()}>
                <MaterialIcons name="view-column" size={20} color={C.text} />
                <Text style={s.tableCtrlLabel}>Add Col</Text>
              </TouchableOpacity>
              <TouchableOpacity testID="fmt-table-delete-row" style={s.tableCtrlBtn} onPress={() => editorApiRef.current?.deleteRow()}>
                <MaterialIcons name="table-rows" size={20} color={C.error} />
                <Text style={[s.tableCtrlLabel, { color: C.error }]}>Del Row</Text>
              </TouchableOpacity>
              <TouchableOpacity testID="fmt-table-delete-col" style={s.tableCtrlBtn} onPress={() => editorApiRef.current?.deleteColumn()}>
                <MaterialIcons name="view-column" size={20} color={C.error} />
                <Text style={[s.tableCtrlLabel, { color: C.error }]}>Del Col</Text>
              </TouchableOpacity>
              <TouchableOpacity testID="fmt-table-delete" style={s.tableCtrlBtn} onPress={() => editorApiRef.current?.deleteTable()}>
                <MaterialIcons name="delete-outline" size={20} color={C.error} />
                <Text style={[s.tableCtrlLabel, { color: C.error }]}>Delete Table</Text>
              </TouchableOpacity>
            </ScrollView>
          )}

          {/* Icon action row - Attachment, Add Tag, Schedule, Link Event, Pin, Image, Share, Delete
              (once saved). Icon-only, spread across the full row width; still horizontally
              scrollable so all of them stay reachable if they don't all fit on a narrow screen.
              Shows when keyboard is hidden - the format toolbar above takes over while typing. */}
          {!isKeyboardVisible && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={s.iconActionBar}
              contentContainerStyle={s.iconActionBarContent}
            >
              <TouchableOpacity
                testID="attach-file-btn"
                style={s.iconActionBtn}
                onPress={pickAttachment}
                disabled={isUploadingAttachment}
              >
                {isUploadingAttachment ? (
                  <ActivityIndicator size="small" color={C.secondary} />
                ) : (
                  <MaterialIcons name="attach-file" size={24} color={C.text} />
                )}
              </TouchableOpacity>
              {tags.length < 3 && (
                <TouchableOpacity testID="add-tag-btn" style={s.iconActionBtn} onPress={() => setShowTagPicker(!showTagPicker)}>
                  <MaterialIcons name="sell" size={24} color={C.text} />
                </TouchableOpacity>
              )}
              <TouchableOpacity
                testID="schedule-event-btn"
                style={s.iconActionBtn}
                onPress={() =>
                  router.push({
                    pathname: '/event-editor',
                    params: { noteId: noteIdRef.current || 'new', noteTitle: title },
                  })
                }
              >
                <MaterialIcons name="calendar-today" size={24} color={C.text} />
              </TouchableOpacity>
              <TouchableOpacity testID="link-event-btn" style={s.iconActionBtn} onPress={openEventPicker}>
                <MaterialIcons name="link" size={24} color={C.text} />
              </TouchableOpacity>
              <TouchableOpacity
                testID="pin-btn"
                style={s.iconActionBtn}
                onPress={togglePin}
              >
                <MaterialIcons name="push-pin" size={24} color={isPinned ? C.primary : C.text} />
              </TouchableOpacity>
              <TouchableOpacity testID="add-image-btn" style={s.iconActionBtn} onPress={() => setShowImagePicker(true)}>
                <MaterialIcons name="add-photo-alternate" size={24} color={C.text} />
              </TouchableOpacity>
              <TouchableOpacity testID="share-btn" style={s.iconActionBtn} onPress={handleShare}>
                <MaterialIcons name="share" size={24} color={C.text} />
              </TouchableOpacity>
              {noteExists && (
                <TouchableOpacity testID="delete-note-btn" style={s.iconActionBtn} onPress={handleDelete}>
                  <MaterialIcons name="delete" size={24} color={C.error} />
                </TouchableOpacity>
              )}
            </ScrollView>
          )}

          {/* Voice Input - always visible, including while typing. KeyboardAvoidingView already
              lifts this whole bottomBar above the keyboard, so this stays pinned right on top of
              it instead of disappearing while composing. */}
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
      
      {/* Image Picker Bottom Sheet */}
      <Modal
        visible={showImagePicker}
        transparent
        animationType="none"
        onRequestClose={() => setShowImagePicker(false)}
      >
        <TouchableOpacity
          style={s.sheetOverlay}
          activeOpacity={1}
          onPress={() => setShowImagePicker(false)}
        >
          <Animated.View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, s.sheetBackdrop, { opacity: imagePickerBackdrop }]}
          />
          <Animated.View style={{ transform: [{ translateY: imagePickerTranslateY }] }}>
            <TouchableOpacity activeOpacity={1} style={s.imagePickerCard}>
              <View style={s.sheetHandle} />
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
                testID="draw-sketch-btn"
                style={s.imagePickerOption}
                onPress={() => { setShowImagePicker(false); router.push('/sketch'); }}
              >
                <MaterialIcons name="draw" size={28} color={C.secondary} />
                <Text style={s.imagePickerOptionText}>Draw</Text>
              </TouchableOpacity>
            </TouchableOpacity>
          </Animated.View>
        </TouchableOpacity>
      </Modal>

      {/* Link Existing Event picker */}
      <Modal
        visible={showEventPicker}
        transparent
        animationType="none"
        onRequestClose={() => setShowEventPicker(false)}
      >
        <TouchableOpacity
          style={s.pickerOverlay}
          activeOpacity={1}
          onPress={() => setShowEventPicker(false)}
        >
          <Animated.View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, s.sheetBackdrop, { opacity: eventPickerBackdrop }]}
          />
          <Animated.View style={{ transform: [{ translateY: eventPickerTranslateY }] }}>
            <TouchableOpacity activeOpacity={1} style={s.pickerSheet}>
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
            </TouchableOpacity>
          </Animated.View>
        </TouchableOpacity>
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
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  statusBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 4, backgroundColor: C.surface,
  },
  statusText: { fontSize: 14, marginLeft: 4 },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 24, paddingTop: 16 },
  titleInput: {
    fontSize: 26, fontWeight: '700', color: C.text,
    paddingBottom: 4, marginBottom: 8,
  },
  tagsSection: { marginTop: 12, marginBottom: 16 },
  tagsRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  tagChip: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8,
    borderWidth: 1.5, marginRight: 8, marginBottom: 8,
  },
  tagChipText: { fontSize: 16, fontWeight: '600', marginRight: 4 },
  tagPicker: {
    backgroundColor: C.surface, marginTop: 8,
  },
  tagPickerHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8,
  },
  tagPickerTitle: { fontSize: 16, fontWeight: '700', color: C.text },
  tagInput: {
    height: 48,
    paddingHorizontal: 12, fontSize: 18, color: C.text, marginBottom: 12,
  },
  colorRow: { flexDirection: 'row', justifyContent: 'space-around', marginBottom: 12 },
  colorDot: { width: 40, height: 40, borderRadius: 20 },
  colorDotSel: { borderWidth: 3, borderColor: C.text },
  confirmTagBtn: { height: 48 },
  contentContainer: {
    marginBottom: 16,
  },
  // Visually contains both the shared-post card and the writing area. No white card background -
  // matches the page so the writing area reads as one continuous surface, not a boxed input.
  inputBox: {
    backgroundColor: C.bg,
    borderRadius: radius.md,
    paddingBottom: 4,
  },
  // The shared-post card nested inside the input box: small gap before text.
  cardInInput: {
    marginHorizontal: 10,
    marginTop: 10,
    marginBottom: 2,
  },
  // No horizontal padding - the writing area's text starts flush with the box edge, at the same
  // x-position as the Title input above (both rely on scrollContent's outer paddingHorizontal).
  richTextWrap: {
    paddingTop: 4,
    paddingBottom: 4,
  },
  // TenTap rich editor (WebView). Explicit pixel height (bodyHeight, computed in NoteBodyEditor)
  // grows the box to fit its actual content - dynamicHeight doesn't work here (see the comment
  // above NoteBodyEditor), so this is a plain style height, not flex/percentage-based, which also
  // means it can't get squeezed by other sections lower on the screen (attachments, linked
  // events). Matches the page background (not white) so it reads as one continuous surface, but
  // still opaque - a transparent Android WebView stops repainting after a parent re-render/blur
  // (e.g. autosave), blanking the text until a tap forces a redraw.
  richText: {
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
  // Event picker modal
  pickerOverlay: { flex: 1, justifyContent: 'flex-end' },
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
  // Event Card Styles - nested inside inputBox (see imagesContainerInBox), inset from the box
  // edge instead of the screen's own outer margin.
  eventCardInBox: {
    backgroundColor: C.surface, borderRadius: 12, padding: 16,
    borderWidth: 2, borderColor: C.secondary, marginTop: 12, marginHorizontal: 10, marginBottom: 4,
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
  // Icon-only, max width 100% (never wider than the screen) - scrolls horizontally on narrow
  // screens or when more icons are added, rather than squeezing/wrapping.
  formatBar: {
    maxWidth: '100%', backgroundColor: C.surface,
    borderBottomWidth: 1, borderBottomColor: C.borderSub + '40',
  },
  formatBarContent: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 8, gap: 4,
  },
  // 44x44 tap target around a 24x24 icon.
  fmtBtn: {
    width: 44, height: 44, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
  },
  fmtBtnActive: {
    backgroundColor: C.primary,
  },
  fmtBtnDisabled: {
    opacity: 0.35,
  },
  tableControlsBar: {
    backgroundColor: C.surface,
    borderBottomWidth: 1, borderBottomColor: C.borderSub + '40',
  },
  tableControlsBarContent: { paddingHorizontal: 8, paddingVertical: 8, gap: 8 },
  tableCtrlBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8,
    backgroundColor: C.bg, borderWidth: 1, borderColor: C.borderSub + '30',
  },
  tableCtrlLabel: { fontSize: 12, color: C.text },
  voiceBar: {
    paddingHorizontal: 24, paddingVertical: 12,
    backgroundColor: C.bg,
  },
  // Icon-only action row (Attachment/Add Tag/Schedule/Link/Pin/Image/Share/Delete). The ScrollView
  // itself spans the full row width (default stretch); contentContainerStyle's flexGrow makes its
  // content match that same full width and spread the icons across it (space-between) whenever
  // they all fit, while still scrolling normally if they ever don't.
  iconActionBar: {
    backgroundColor: C.bg,
    borderBottomWidth: 1,
    borderBottomColor: C.borderSub + '40',
  },
  iconActionBarContent: {
    flexGrow: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
  },
  // 48x48 tap target (finger-friendly minimum) around a 24x24 icon.
  iconActionBtn: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
  // Same section, but nested inside inputBox (Attachments/Attached Images now render inline
  // with the writing area) - inset from the box edge like cardInInput rather than the screen's
  // own outer margin.
  imagesContainerInBox: {
    marginTop: 12,
    marginHorizontal: 10,
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
  // Image Picker Bottom Sheet
  sheetOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheetBackdrop: {
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheetHandle: {
    width: 40, height: 4, borderRadius: 2, backgroundColor: C.borderSub,
    alignSelf: 'center', marginBottom: 16,
  },
  imagePickerCard: {
    backgroundColor: C.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 12,
    paddingHorizontal: 24,
    paddingBottom: 40,
    width: '100%',
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
});
