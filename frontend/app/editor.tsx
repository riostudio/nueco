import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  ScrollView, KeyboardAvoidingView, Platform, Alert, ActivityIndicator,
  Keyboard, Share, Modal, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { useAudioRecorder, AudioModule, RecordingPresets, setAudioModeAsync } from 'expo-audio';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as WebBrowser from 'expo-web-browser';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { notesApi, eventsApi, transcribeApi, textProcessApi, attachmentsApi, uploadAttachmentWithProgress, type UploadFile } from '../src/api';
import { RadialProgress, SharedPostCard } from '../src/components';
import { decryptNoteFromServer } from '../src/crypto/noteCrypto';
import { createNoteOffline, updateNoteOffline, getLocalNotes, processSyncQueue } from '../src/offlineSync';
import { takePendingShareDraft } from '../src/share/pendingShareDraft';
import { parseSourcePost, serializeSourcePost, type SourcePost } from '../src/share/socialSource';
import { unfurl, needsUnfurl } from '../src/share/unfurl';
import { plainTextFromContent } from '../src/textContent';
import { RichText, useEditorBridge, useEditorContent, useBridgeState } from '@10play/tentap-editor';
import { Tag, CalendarEvent, Attachment } from '../src/types';
import { TAG_COLORS, C } from '../src/theme';
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
  // Rich-text editor (TenTap). The note body is HTML; `contentRef` holds the latest for saving.
  const editor = useEditorBridge({ autofocus: false, avoidIosKeyboard: true, dynamicHeight: true, initialContent: '' });
  const editorState = useBridgeState(editor);
  const editorHtml = useEditorContent(editor, { type: 'html', debounceInterval: 400 });
  // HTML to seed into the editor once its webview is ready (null until the note is loaded).
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
  // True once the user actually edits — a pre-filled shared draft that's never touched
  // is discarded on back rather than silently saved.
  const userEditedRef = useRef(false);
  
  // State to track if note exists (for UI rendering like delete button)
  const [noteExists, setNoteExists] = useState(!isNew);

  useEffect(() => { titleRef.current = title; }, [title]);
  useEffect(() => { tagsRef.current = tags; }, [tags]);
  useEffect(() => { isPinnedRef.current = isPinned; }, [isPinned]);
  useEffect(() => { linkedEventIdRef.current = linkedEventId; }, [linkedEventId]);
  useEffect(() => { imagesRef.current = images; }, [images]);
  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);
  useEffect(() => { sourcePostRef.current = sourcePost; }, [sourcePost]);
  useEffect(() => { thumbInImages0Ref.current = thumbInImages0; }, [thumbInImages0]);

  // Seed the editor once its webview is ready and we have content to load (new/shared/loaded note).
  useEffect(() => {
    if (seededRef.current || !editorState.isReady || seedHtml == null) return;
    seededRef.current = true;
    contentRef.current = seedHtml;
    seedPlainRef.current = plainTextFromContent(seedHtml);
    if (seedHtml) editor.setContent(seedHtml);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorState.isReady, seedHtml]);

  // Editor edits → keep contentRef fresh + autosave. Ignore the seed echo so loading a pristine
  // note doesn't mark it dirty or create an empty note.
  useEffect(() => {
    if (editorHtml == null || !seededRef.current) return;
    contentRef.current = editorHtml;
    if (!userEditedRef.current && plainTextFromContent(editorHtml) === seedPlainRef.current) return;
    triggerAutoSave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorHtml]);

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
          // A TikTok thumbnail is a video poster → show the play overlay.
          kind: prev.platform === 'tiktok' && res.thumbnailUrl ? 'video' : prev.kind,
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
  // shared note persists automatically — no manual save/edit required.
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
      let note: any;
      if (id.startsWith('local_')) {
        // Not-yet-synced note — read the plaintext copy from local storage.
        note = (await getLocalNotes()).find(n => n.id === id);
        if (!note) throw new Error('local note not found');
      } else {
        try {
          note = await decryptNoteFromServer(await notesApi.get(id));
        } catch (e) {
          // Offline / fetch failed — fall back to the local copy if we have one.
          const local = (await getLocalNotes()).find(n => n.id === id);
          if (!local) throw e;
          note = local;
        }
      }
      setTitle(note.title);
      // A shared-post card is persisted as a marker at the end of content; split it back out.
      const parsed = parseSourcePost(note.content || '');
      // Hold the loaded body immediately so a quick back-out before the WebView seeds can't
      // overwrite the note with empty content.
      contentRef.current = parsed.content || '';
      setSeedHtml(parsed.content || ''); // seed the rich editor with the note body (HTML or legacy text)
      if (parsed.sourcePost) {
        setSourcePost(parsed.sourcePost);
        setThumbInImages0(parsed.thumbInImages0);
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
          const event = await eventsApi.get(note.linked_event_id);
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
            const event = await eventsApi.get(pendingEventId);
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
              const event = await eventsApi.get(note.linked_event_id);
              setLinkedEvent(event);
            }
          } catch (e) {
            console.error('Failed to refresh note data:', e);
          }
        } else if (linkedEventId) {
          // Just refresh event if we already have a linkedEventId
          try {
            const event = await eventsApi.get(linkedEventId);
            setLinkedEvent(event);
          } catch (e) {
            console.error('Failed to refresh event:', e);
          }
        }
      };
      
      refreshData();
    }, [linkedEventId])
  );

  // Offline-first save: writes locally + enqueues for sync. Encryption happens once,
  // at the offlineSync push boundary. `push: false` (autosave) defers the network sync
  // so a mid-session id swap can't strand `noteIdRef`; the queue is flushed on exit.
  const persistLocal = useCallback(async (opts: { push?: boolean } = {}): Promise<void> => {
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
        // Local write only (push deferred to exit/background) — always succeeds offline.
        await persistLocal({ push: false });
        setSaveStatus('All changes saved');
      } catch (e: any) {
        setSaveStatus('Failed to save');
        console.error('Autosave error:', e);
      }
    }, 2000);
  }, [persistLocal]);

  const handleBack = useCallback(async () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
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
  }, [router, persistLocal]);

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
    try { current = await editor.getHTML(); } catch {}
    const base = current.replace(/<p><\/p>\s*$/i, ''); // drop a trailing empty paragraph
    editor.setContent(base + paras);
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
    
    // Add linked event details with Event header
    if (linkedEvent) {
      shareText += '\n📅 Event\n\n';
      shareText += `Title: ${linkedEvent.title}\n`;
      shareText += `Start: ${formatEventDateTime(linkedEvent.start_time)}\n`;
      shareText += `End: ${formatEventDateTime(linkedEvent.end_time)}\n`;
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

  // File attachment (paperclip) — picks a file, uploads to storage, embeds metadata.
  // Online-direct, matching the editor's existing save model. Never base64-inlines.
  const MAX_ATTACHMENT_MB = 100;
  const MAX_PICK_AT_ONCE = 10;

  // Upload files (shared or in-app-picked) with per-file radial progress. Each completed
  // upload is appended to attachments[] and autosaved. Used by both the share pre-fill
  // and pickAttachment (new + edit), so progress shows consistently everywhere.
  const uploadFiles = useCallback(async (files: UploadFile[]) => {
    for (const file of files) {
      if ((file.size ?? 0) > MAX_ATTACHMENT_MB * 1024 * 1024) {
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
        const notEnabled = e?.message?.includes('503') || e?.message?.includes('not enabled');
        Alert.alert(
          'Upload failed',
          notEnabled ? 'File attachments aren’t enabled on the server yet.' : `Couldn’t upload ${file.name}.`,
        );
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
      const events = await eventsApi.getAll();
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
    // Nothing to save? (also save if there's a linked event, images, or attachments —
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
    Alert.alert('Delete Note', 'Are you sure you want to delete this note?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            // Use noteIdRef or the noteId from params
            const idToDelete = noteIdRef.current || noteId;
            console.log('Attempting to delete note:', idToDelete, 'isCreatedRef:', isCreatedRef.current);
            
            if (idToDelete) {
              await notesApi.delete(idToDelete);
              // Track note deletion
              trackNoteDeleted();
              console.log('Note deleted successfully');
            } else {
              console.log('No note ID to delete');
            }
          } catch (e) {
            console.error('Delete failed:', e);
            Alert.alert('Error', 'Failed to delete note. Please try again.');
            return; // Don't navigate away if delete failed
          }
          router.back();
        },
      },
    ]);
  };

  if (loading) {
    return (
      <SafeAreaView style={s.container}>
        <View style={s.center}>
          <ActivityIndicator size="large" color={C.primary} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.container}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {/* Header */}
        <View style={s.header}>
          <TouchableOpacity testID="back-btn" style={s.headerBtn} onPress={handleSaveAndBack}>
            <MaterialIcons name="arrow-back" size={28} color={C.primary} />
            <Text style={[s.headerBtnLabel, { color: C.primary }]}>Back</Text>
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
                  <MaterialIcons name="add" size={20} color={C.primary} />
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

          {/* Content — the shared-post card sits at the top of the input box, then the writing area */}
          <View style={s.contentContainer}>
            <View style={s.inputBox}>
              {/* Shared social post card (Instagram/Facebook/WhatsApp/YouTube/…) — links back to the post */}
              {sourcePost && (
                <SharedPostCard
                  style={s.cardInInput}
                  source={thumbInImages0 && images[0] ? { ...sourcePost, thumbnail: images[0] } : sourcePost}
                  onOpen={openSourcePost}
                  onRemove={removeSourcePost}
                />
              )}
              {/* Rich-text body (TenTap WebView). dynamicHeight lets it grow inside the page scroll.
                  The padded wrapper insets the editor from the box border so text isn't flush. */}
              <View style={s.richTextWrap}>
                <RichText editor={editor} style={s.richText} scrollEnabled={false} />
              </View>
              {/* Attach-file footer — a WebView can't be overlaid, so the paperclip sits below it */}
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
                  <MaterialIcons name="delete-outline" size={22} color={C.error} />
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
            <View>
              <TouchableOpacity
                testID="schedule-event-btn"
                style={s.calBtn}
                onPress={() =>
                  router.push({
                    pathname: '/event-editor',
                    params: {
                      noteId: noteIdRef.current || 'new',
                      noteTitle: title,
                    },
                  })
                }
              >
                <MaterialIcons name="calendar-today" size={24} color={C.secondary} />
                <Text style={s.calBtnText}>Schedule New Event</Text>
                <MaterialIcons name="chevron-right" size={24} color={C.borderSub} />
              </TouchableOpacity>
              <TouchableOpacity
                testID="link-event-btn"
                style={[s.calBtn, { marginTop: 10 }]}
                onPress={openEventPicker}
              >
                <MaterialIcons name="link" size={24} color={C.secondary} />
                <Text style={s.calBtnText}>Link Existing Event</Text>
                <MaterialIcons name="chevron-right" size={24} color={C.borderSub} />
              </TouchableOpacity>
            </View>
          )}

          <View style={{ height: 120 }} />
        </ScrollView>

        {/* Voice Input Bar + Format Toolbar */}
        <View style={s.bottomBar}>
          {/* Format Toolbar — drives the TenTap editor; shows while it's focused (disabled on web) */}
          {editorState.isFocused && Platform.OS !== 'web' && (
            <View style={s.formatBar}>
              <TouchableOpacity
                testID="fmt-bold"
                style={[s.fmtBtn, editorState.isBoldActive && s.fmtBtnActive]}
                onPress={() => editor.toggleBold()}
              >
                <Text style={[s.fmtBold, editorState.isBoldActive && s.fmtTextActive]}>B</Text>
                <Text style={[s.fmtLabel, editorState.isBoldActive && s.fmtLabelActive]}>Bold</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="fmt-italic"
                style={[s.fmtBtn, editorState.isItalicActive && s.fmtBtnActive]}
                onPress={() => editor.toggleItalic()}
              >
                <Text style={[s.fmtItalic, editorState.isItalicActive && s.fmtTextActive]}>I</Text>
                <Text style={[s.fmtLabel, editorState.isItalicActive && s.fmtLabelActive]}>Italic</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="fmt-bullet"
                style={[s.fmtBtn, editorState.isBulletListActive && s.fmtBtnActive]}
                onPress={() => editor.toggleBulletList()}
              >
                <MaterialIcons name="format-list-bulleted" size={22} color={editorState.isBulletListActive ? C.primary : C.text} />
                <Text style={[s.fmtLabel, editorState.isBulletListActive && s.fmtLabelActive]}>List</Text>
              </TouchableOpacity>
            </View>
          )}
          
          {/* Action Buttons - Pin, Add Image, Share, Delete - shows when keyboard is hidden */}
          {!isKeyboardVisible && (
            <View style={s.actionBar}>
              <TouchableOpacity testID="pin-btn" style={s.actionBtn} onPress={togglePin}>
                <MaterialIcons
                  name="push-pin"
                  size={24}
                  color={isPinned ? C.primary : C.borderSub}
                />
                <Text style={[s.actionBtnLabel, isPinned && { color: C.primary }]}>
                  {isPinned ? 'Pinned' : 'Pin'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity testID="add-image-btn" style={s.actionBtn} onPress={() => setShowImagePicker(true)}>
                <MaterialIcons name="add-photo-alternate" size={24} color={C.secondary} />
                <Text style={[s.actionBtnLabel, { color: C.secondary }]}>Image</Text>
              </TouchableOpacity>
              <TouchableOpacity testID="share-btn" style={s.actionBtn} onPress={handleShare}>
                <MaterialIcons name="share" size={24} color={C.secondary} />
                <Text style={[s.actionBtnLabel, { color: C.secondary }]}>Share</Text>
              </TouchableOpacity>
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
                <TouchableOpacity
                  testID="voice-input-btn"
                  style={[s.voiceBtn, isRecording && s.voiceBtnRec]}
                  onPress={isRecording ? stopRecording : startRecording}
                  activeOpacity={0.7}
                >
                  <MaterialIcons
                    name={isRecording ? 'stop' : 'mic'}
                    size={28}
                    color={isRecording ? C.primaryFg : C.primary}
                  />
                  <Text style={[s.voiceBtnText, isRecording && s.voiceBtnTextRec]}>
                    {isRecording ? 'Stop Recording' : 'Voice Input'}
                  </Text>
                </TouchableOpacity>
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
    borderBottomWidth: 2, borderBottomColor: C.borderSub + '60',
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
    paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 8, borderWidth: 1.5, borderColor: C.primary,
    borderStyle: 'dashed', marginBottom: 8,
  },
  addTagText: { fontSize: 16, fontWeight: '600', color: C.primary, marginLeft: 4 },
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
    borderRadius: 12,
    borderWidth: 2,
    borderColor: C.borderSub,
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
  // TenTap rich editor (WebView). dynamicHeight grows it to content; minHeight gives tap space.
  richText: {
    minHeight: 150,
    backgroundColor: 'transparent',
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
  calBtn: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.surface, borderRadius: 12, padding: 16,
    borderWidth: 2, borderColor: C.borderSub, marginTop: 16,
  },
  calBtnText: { flex: 1, fontSize: 18, color: C.secondary, marginLeft: 12, fontWeight: '500' },
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
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 24,
    gap: 24,
    backgroundColor: C.bg,
    borderBottomWidth: 1,
    borderBottomColor: C.borderSub + '40',
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6,
  },
  actionBtnLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: C.textSec,
  },
  transcribing: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    height: 56,
  },
  transcribingText: { fontSize: 18, color: C.textSec, marginLeft: 12 },
  voiceBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    height: 56, borderRadius: 28, borderWidth: 2, borderColor: C.primary,
    backgroundColor: C.surface,
  },
  voiceBtnRec: { backgroundColor: C.error, borderColor: C.error },
  voiceBtnText: { fontSize: 20, fontWeight: '600', color: C.primary, marginLeft: 8 },
  voiceBtnTextRec: { color: C.primaryFg },
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
