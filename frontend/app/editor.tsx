import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  ScrollView, KeyboardAvoidingView, Platform, Alert, ActivityIndicator,
  Keyboard, Share,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useAudioRecorder, AudioModule, RecordingPresets, useAudioRecorderState } from 'expo-audio';
import Markdown from 'react-native-markdown-display';
import { notesApi, transcribeApi } from '../src/api';
import { Tag } from '../src/types';
import { TAG_COLORS } from '../src/theme';

const C = {
  primary: '#D84315',
  primaryFg: '#FFFFFF',
  secondary: '#1565C0',
  bg: '#FDFBF7',
  surface: '#FFFFFF',
  text: '#121212',
  textSec: '#37474F',
  border: '#121212',
  borderSub: '#78909C',
  success: '#2E7D32',
  error: '#C62828',
};

export default function EditorScreen() {
  const router = useRouter();
  const { noteId } = useLocalSearchParams<{ noteId: string }>();
  const isNew = noteId === 'new';

  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState<Tag[]>([]);
  const [isPinned, setIsPinned] = useState(false);
  const [linkedEventId, setLinkedEventId] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState('');
  const [loading, setLoading] = useState(!isNew);

  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(audioRecorder);

  const [showTagPicker, setShowTagPicker] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [selectedTagColor, setSelectedTagColor] = useState(TAG_COLORS[0].value);
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const [isBoldActive, setIsBoldActive] = useState(false);
  const [isItalicActive, setIsItalicActive] = useState(false);

  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const contentInputRef = useRef<TextInput>(null);
  const lastContentLength = useRef(0);

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
  const contentRef = useRef(content);
  const tagsRef = useRef(tags);
  const isPinnedRef = useRef(isPinned);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { titleRef.current = title; }, [title]);
  useEffect(() => { contentRef.current = content; }, [content]);
  useEffect(() => { tagsRef.current = tags; }, [tags]);
  useEffect(() => { isPinnedRef.current = isPinned; }, [isPinned]);

  useEffect(() => {
    if (!isNew && noteId) loadNote(noteId);
  }, [noteId]);

  const loadNote = async (id: string) => {
    try {
      const note = await notesApi.get(id);
      setTitle(note.title);
      setContent(note.content);
      setTags(note.tags);
      setIsPinned(note.is_pinned);
      setLinkedEventId(note.linked_event_id);
      noteIdRef.current = note.id;
      isCreatedRef.current = true;
    } catch (e) {
      console.error('Failed to load note:', e);
    } finally {
      setLoading(false);
    }
  };

  const triggerAutoSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setSaveStatus('Unsaved changes');
    saveTimerRef.current = setTimeout(async () => {
      setSaveStatus('Saving...');
      try {
        if (!isCreatedRef.current) {
          const created = await notesApi.create({
            title: titleRef.current,
            content: contentRef.current,
            tags: tagsRef.current,
            is_pinned: isPinnedRef.current,
          });
          noteIdRef.current = created.id;
          isCreatedRef.current = true;
        } else if (noteIdRef.current) {
          await notesApi.update(noteIdRef.current, {
            title: titleRef.current,
            content: contentRef.current,
            tags: tagsRef.current,
            is_pinned: isPinnedRef.current,
          });
        }
        setSaveStatus('All changes saved');
      } catch (e) {
        setSaveStatus('Failed to save');
        console.error('Save error:', e);
      }
    }, 2000);
  }, []);

  const handleBack = useCallback(async () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    try {
      if (!isCreatedRef.current && (titleRef.current || contentRef.current)) {
        await notesApi.create({
          title: titleRef.current,
          content: contentRef.current,
          tags: tagsRef.current,
          is_pinned: isPinnedRef.current,
        });
      } else if (isCreatedRef.current && noteIdRef.current) {
        await notesApi.update(noteIdRef.current, {
          title: titleRef.current,
          content: contentRef.current,
          tags: tagsRef.current,
          is_pinned: isPinnedRef.current,
        });
      }
    } catch (e) {
      console.error('Save on back failed:', e);
    }
    router.back();
  }, [router]);

  const handleTitleChange = (text: string) => {
    setTitle(text);
    triggerAutoSave();
  };

  const handleContentChange = (newText: string) => {
    const oldLength = lastContentLength.current;
    const newLength = newText.length;
    
    // Check if user is typing new characters (not deleting)
    if (newLength > oldLength && (isBoldActive || isItalicActive)) {
      const addedText = newText.substring(oldLength);
      const baseText = newText.substring(0, oldLength);
      
      let formattedAddition = addedText;
      if (isBoldActive && isItalicActive) {
        formattedAddition = `***${addedText}***`;
      } else if (isBoldActive) {
        formattedAddition = `**${addedText}**`;
      } else if (isItalicActive) {
        formattedAddition = `*${addedText}*`;
      }
      
      const finalText = baseText + formattedAddition;
      setContent(finalText);
      lastContentLength.current = finalText.length;
    } else {
      setContent(newText);
      lastContentLength.current = newText.length;
    }
    
    triggerAutoSave();
  };

  const toggleBold = () => {
    setIsBoldActive(!isBoldActive);
  };

  const toggleItalic = () => {
    setIsItalicActive(!isItalicActive);
  };

  // Convert markdown to plain text for sharing
  const convertMarkdownToPlainText = (markdown: string): string => {
    return markdown
      .replace(/\*\*\*(.*?)\*\*\*/g, '$1')  // Bold+Italic
      .replace(/\*\*(.*?)\*\*/g, '$1')       // Bold
      .replace(/\*(.*?)\*/g, '$1')           // Italic
      .replace(/^- /gm, '• ')                // Bullet points
      .replace(/^#{1,6}\s/gm, '');           // Headers
  };

  const handleShare = async () => {
    if (!title && !content) {
      Alert.alert('Nothing to Share', 'Please add a title or content to your note first.');
      return;
    }

    const plainContent = convertMarkdownToPlainText(content);
    const shareText = title 
      ? `${title}\n\n${plainContent}`
      : plainContent;

    try {
      const result = await Share.share({
        message: shareText,
        title: title || 'My Note',
      });

      if (result.action === Share.sharedAction) {
        if (result.activityType) {
          console.log('Shared via:', result.activityType);
        }
      }
    } catch (error) {
      console.error('Share error:', error);
      Alert.alert('Share Failed', 'Unable to share the note. Please try again.');
    }
  };

  const insertFormatting = (type: 'bold' | 'italic' | 'bullet') => {
    const before = content.substring(0, selection.start);
    const selected = content.substring(selection.start, selection.end);
    const after = content.substring(selection.end);
    let newContent = content;

    switch (type) {
      case 'bold':
        newContent = before + '**' + (selected || 'bold text') + '**' + after;
        break;
      case 'italic':
        newContent = before + '*' + (selected || 'italic text') + '*' + after;
        break;
      case 'bullet':
        newContent = before + '\n- ' + (selected || '') + after;
        break;
    }
    setContent(newContent);
    triggerAutoSave();
  };

  const startRecording = async () => {
    try {
      const status = await AudioModule.requestRecordingPermissionsAsync();
      if (!status.granted) {
        Alert.alert('Permission Needed', 'Microphone access is required for voice input.');
        return;
      }
      await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();
      setIsRecording(true);
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
      if (!uri) return;

      setIsTranscribing(true);
      const result = await transcribeApi.transcribe(uri);
      const newContent = content + (content ? ' ' : '') + result.text;
      setContent(newContent);
      triggerAutoSave();
    } catch (e) {
      console.error('Transcription failed:', e);
      Alert.alert('Error', 'Voice transcription failed. Please try again.');
    } finally {
      setIsTranscribing(false);
    }
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

  const handleDelete = () => {
    Alert.alert('Delete Note', 'Are you sure you want to delete this note?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          if (isCreatedRef.current && noteIdRef.current) {
            try { await notesApi.delete(noteIdRef.current); } catch (e) { console.error(e); }
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
          <TouchableOpacity testID="back-btn" style={s.headerBtn} onPress={handleBack}>
            <MaterialIcons name="arrow-back" size={28} color={C.text} />
            <Text style={s.headerBtnLabel}>Back</Text>
          </TouchableOpacity>
          <View style={s.headerRight}>
            <TouchableOpacity testID="pin-btn" style={s.headerBtn} onPress={togglePin}>
              <MaterialIcons
                name="push-pin"
                size={24}
                color={isPinned ? C.primary : C.borderSub}
              />
              <Text style={[s.headerBtnLabel, isPinned && { color: C.primary }]}>
                {isPinned ? 'Pinned' : 'Pin'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity testID="share-btn" style={s.headerBtn} onPress={handleShare}>
              <MaterialIcons name="share" size={24} color={C.secondary} />
              <Text style={[s.headerBtnLabel, { color: C.secondary }]}>Share</Text>
            </TouchableOpacity>
            {isCreatedRef.current && (
              <TouchableOpacity testID="delete-btn" style={s.headerBtn} onPress={handleDelete}>
                <MaterialIcons name="delete" size={24} color={C.error} />
                <Text style={[s.headerBtnLabel, { color: C.error }]}>Delete</Text>
              </TouchableOpacity>
            )}
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

          {/* Content - WYSIWYG Style: Hidden input with visible formatted output */}
          <View style={s.contentContainer}>
            {/* Invisible TextInput that captures keyboard input */}
            <TextInput
              ref={contentInputRef}
              testID="note-content-input"
              style={s.hiddenInput}
              value={content}
              onChangeText={handleContentChange}
              multiline
              textAlignVertical="top"
              onSelectionChange={(e) => setSelection(e.nativeEvent.selection)}
              autoCorrect={true}
              autoCapitalize="sentences"
            />
            
            {/* Visible formatted content - tap to edit */}
            <TouchableOpacity 
              style={s.formattedBox}
              onPress={() => contentInputRef.current?.focus()}
              activeOpacity={1}
            >
              {content ? (
                <Markdown style={markdownStyles}>
                  {content}
                </Markdown>
              ) : (
                <Text style={s.placeholderText}>Tap here to start writing...</Text>
              )}
            </TouchableOpacity>
          </View>

          {/* Calendar Link */}
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
            <Text style={s.calBtnText}>
              {linkedEventId ? 'Linked to Calendar Event' : 'Schedule Calendar Event'}
            </Text>
            <MaterialIcons name="chevron-right" size={24} color={C.borderSub} />
          </TouchableOpacity>

          <View style={{ height: 120 }} />
        </ScrollView>

        {/* Voice Input Bar + Format Toolbar */}
        <View style={s.bottomBar}>
          {/* Format Toolbar - shows when keyboard is visible */}
          {isKeyboardVisible && (
            <View style={s.formatBar}>
              <TouchableOpacity 
                testID="fmt-bold" 
                style={[s.fmtBtn, isBoldActive && s.fmtBtnActive]} 
                onPress={toggleBold}
              >
                <Text style={[s.fmtBold, isBoldActive && s.fmtTextActive]}>B</Text>
                <Text style={[s.fmtLabel, isBoldActive && s.fmtLabelActive]}>Bold</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                testID="fmt-italic" 
                style={[s.fmtBtn, isItalicActive && s.fmtBtnActive]} 
                onPress={toggleItalic}
              >
                <Text style={[s.fmtItalic, isItalicActive && s.fmtTextActive]}>I</Text>
                <Text style={[s.fmtLabel, isItalicActive && s.fmtLabelActive]}>Italic</Text>
              </TouchableOpacity>
              <TouchableOpacity testID="fmt-bullet" style={s.fmtBtn} onPress={() => insertFormatting('bullet')}>
                <MaterialIcons name="format-list-bulleted" size={22} color={C.text} />
                <Text style={s.fmtLabel}>List</Text>
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
    position: 'relative',
  },
  hiddenInput: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    opacity: 0,
    fontSize: 18,
    padding: 16,
  },
  formattedBox: {
    minHeight: 150,
    backgroundColor: C.surface,
    borderRadius: 12,
    padding: 16,
    borderWidth: 2,
    borderColor: C.borderSub,
  },
  placeholderText: {
    fontSize: 18,
    color: C.borderSub,
    fontStyle: 'italic',
  },
  calBtn: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.surface, borderRadius: 12, padding: 16,
    borderWidth: 2, borderColor: C.borderSub, marginTop: 16,
  },
  calBtnText: { flex: 1, fontSize: 18, color: C.secondary, marginLeft: 12, fontWeight: '500' },
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
});

// Markdown styles for rendering formatted text
const markdownStyles = StyleSheet.create({
  body: { fontSize: 18, color: C.text, lineHeight: 28 },
  heading1: { fontSize: 28, fontWeight: '700', color: C.text, marginVertical: 8 },
  heading2: { fontSize: 24, fontWeight: '700', color: C.text, marginVertical: 6 },
  heading3: { fontSize: 20, fontWeight: '600', color: C.text, marginVertical: 4 },
  strong: { fontWeight: '700' },
  em: { fontStyle: 'italic' },
  bullet_list: { marginVertical: 8 },
  ordered_list: { marginVertical: 8 },
  list_item: { flexDirection: 'row', marginVertical: 4 },
  bullet_list_icon: { fontSize: 18, color: C.primary, marginRight: 8 },
  code_inline: { 
    backgroundColor: C.borderSub + '30', paddingHorizontal: 6, 
    borderRadius: 4, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  fence: {
    backgroundColor: C.borderSub + '20', padding: 12, borderRadius: 8,
    marginVertical: 8,
  },
  link: { color: C.secondary, textDecorationLine: 'underline' },
});
