import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  ScrollView, KeyboardAvoidingView, Platform, Alert, ActivityIndicator,
  Keyboard, Share, Modal, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useAudioRecorder, AudioModule, RecordingPresets, setAudioModeAsync } from 'expo-audio';
import * as ImagePicker from 'expo-image-picker';
import { notesApi, transcribeApi, textProcessApi } from '../src/api';
import { Tag } from '../src/types';
import { TAG_COLORS } from '../src/theme';
import { 
  authStorage, 
  useAuth,
  UserAvatar,
} from '../src/auth';

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
  const isNew = !noteId || noteId === 'new';

  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState<Tag[]>([]);
  const [isPinned, setIsPinned] = useState(false);
  const [linkedEventId, setLinkedEventId] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState('');
  const [loading, setLoading] = useState(!isNew);

  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isProcessingText, setIsProcessingText] = useState(false);
  const [showAiSuggestion, setShowAiSuggestion] = useState(false);
  const [transcribedText, setTranscribedText] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [showImagePicker, setShowImagePicker] = useState(false);
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

  const [showTagPicker, setShowTagPicker] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [selectedTagColor, setSelectedTagColor] = useState(TAG_COLORS[0].value);
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const [isBoldActive, setIsBoldActive] = useState(false);
  const [isItalicActive, setIsItalicActive] = useState(false);

  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const contentInputRef = useRef<TextInput>(null);
  const lastContentLength = useRef(0);

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
  const contentRef = useRef(content);
  const tagsRef = useRef(tags);
  const isPinnedRef = useRef(isPinned);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  // State to track if note exists (for UI rendering like delete button)
  const [noteExists, setNoteExists] = useState(!isNew);

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
      setNoteExists(true);
    } catch (e) {
      console.error('Failed to load note:', e);
    } finally {
      setLoading(false);
    }
  };

  // Retry helper for network resilience
  const retryOperation = async (operation: () => Promise<any>, maxRetries = 3): Promise<any> => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (e) {
        console.log(`Save attempt ${attempt} failed:`, e);
        if (attempt === maxRetries) throw e;
        // Wait before retrying (exponential backoff)
        await new Promise(resolve => setTimeout(resolve, attempt * 500));
      }
    }
  };

  const triggerAutoSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setSaveStatus('Unsaved changes');
    saveTimerRef.current = setTimeout(async () => {
      setSaveStatus('Saving...');
      try {
        if (!isCreatedRef.current) {
          const created = await retryOperation(() => notesApi.create({
            title: titleRef.current,
            content: contentRef.current,
            tags: tagsRef.current,
            is_pinned: isPinnedRef.current,
          }));
          noteIdRef.current = created.id;
          isCreatedRef.current = true;
          setNoteExists(true);
        } else if (noteIdRef.current) {
          await retryOperation(() => notesApi.update(noteIdRef.current, {
            title: titleRef.current,
            content: contentRef.current,
            tags: tagsRef.current,
            is_pinned: isPinnedRef.current,
          }));
        }
        setSaveStatus('All changes saved');
      } catch (e: any) {
        // Show more helpful error message
        const errorMsg = e?.message?.includes('Network') 
          ? 'Network error - tap to retry' 
          : 'Failed to save';
        setSaveStatus(errorMsg);
        console.error('Save error after retries:', e);
      }
    }, 2000);
  }, []);

  const handleBack = useCallback(async () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    try {
      if (!isCreatedRef.current && (titleRef.current || contentRef.current)) {
        await retryOperation(() => notesApi.create({
          title: titleRef.current,
          content: contentRef.current,
          tags: tagsRef.current,
          is_pinned: isPinnedRef.current,
        }));
      } else if (isCreatedRef.current && noteIdRef.current) {
        await retryOperation(() => notesApi.update(noteIdRef.current, {
          title: titleRef.current,
          content: contentRef.current,
          tags: tagsRef.current,
          is_pinned: isPinnedRef.current,
        }));
      }
    } catch (e) {
      console.error('Save on back failed after retries:', e);
    }
    router.back();
  }, [router]);

  const handleTitleChange = (text: string) => {
    setTitle(text);
    triggerAutoSave();
  };

  const handleContentChange = (newText: string) => {
    setContent(newText);
    lastContentLength.current = newText.length;
    triggerAutoSave();
  };

  // Toggle format button state (visual indicator only)
  // Note: True WYSIWYG requires a rich text editor library
  // For now, format buttons show intent but don't insert markdown
  const toggleBold = () => {
    setIsBoldActive(!isBoldActive);
    contentInputRef.current?.focus();
  };

  const toggleItalic = () => {
    setIsItalicActive(!isItalicActive);
    contentInputRef.current?.focus();
  };

  const insertBullet = () => {
    // Insert a bullet point character directly
    const bulletChar = '\u2022 '; // bullet character
    const newContent = content + (content.endsWith('\n') || content === '' ? '' : '\n') + bulletChar;
    setContent(newContent);
    lastContentLength.current = newContent.length;
    triggerAutoSave();
    contentInputRef.current?.focus();
  };

  // Convert content to plain text for sharing (remove bullet chars)
  const convertToPlainText = (text: string): string => {
    return text.replace(/\u2022 /g, '- '); // Convert bullet chars back to dashes
  };

  const handleShare = async () => {
    if (!title && !content) {
      Alert.alert('Nothing to Share', 'Please add a title or content to your note first.');
      return;
    }

    const plainContent = convertToPlainText(content);
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
    
    if (action === 'keep') {
      // Just add the transcribed text as-is
      const newContent = content + (content ? ' ' : '') + transcribedText;
      setContent(newContent);
      triggerAutoSave();
      return;
    }

    try {
      setIsProcessingText(true);
      const result = await textProcessApi.processText(transcribedText, action);
      const newContent = content + (content ? '\n\n' : '') + result.text;
      setContent(newContent);
      triggerAutoSave();
    } catch (e) {
      console.error('Text processing failed:', e);
      Alert.alert('Error', 'AI processing failed. Adding original text.');
      // Fallback to original text
      const newContent = content + (content ? ' ' : '') + transcribedText;
      setContent(newContent);
      triggerAutoSave();
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
      const imageUri = result.assets[0].uri;
      setImages(prev => [...prev, imageUri]);
      triggerAutoSave();
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
    });

    if (!result.canceled && result.assets.length > 0) {
      const newImages = result.assets.map(asset => asset.uri);
      setImages(prev => [...prev, ...newImages]);
      triggerAutoSave();
    }
  };

  const removeImage = (index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index));
    triggerAutoSave();
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
    // Check if there's content to save
    if (!title.trim() && !content.trim()) {
      router.replace('/(tabs)');
      return;
    }

    setSaveStatus('Saving...');
    let saveSucceeded = false;
    
    try {
      if (!isCreatedRef.current) {
        const created = await retryOperation(() => notesApi.create({
          title: titleRef.current,
          content: contentRef.current,
          tags: tagsRef.current,
          is_pinned: isPinnedRef.current,
        }));
        noteIdRef.current = created.id;
        isCreatedRef.current = true;
        setNoteExists(true);
        saveSucceeded = true;
      } else if (noteIdRef.current) {
        await retryOperation(() => notesApi.update(noteIdRef.current, {
          title: titleRef.current,
          content: contentRef.current,
          tags: tagsRef.current,
          is_pinned: isPinnedRef.current,
        }));
        saveSucceeded = true;
      }
      setSaveStatus('All changes saved');
    } catch (e: any) {
      const errorMsg = e?.message?.includes('Network') 
        ? 'Network error - changes may not be saved' 
        : 'Could not save - please try again later';
      setSaveStatus(errorMsg);
      console.error('Save error after retries:', e);
      // Continue to navigate back even if save failed - don't trap the user
    }
    
    // Always navigate back, regardless of save success
    // Check if user needs to see sign-up prompt first
    if (saveSucceeded) {
      try {
        const modalDismissed = await authStorage.isModalDismissed();
        const userHasEmail = authUser?.email;
        const userVerified = authUser?.email_verified || authUser?.mobile_verified;
        
        if (!modalDismissed && !userHasEmail && !userVerified) {
          await authStorage.setFirstNoteSaved();
          setShowLinkSheet(true);
          return; // Don't navigate yet, show signup sheet
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
            {/* User Avatar - shows first letter of email when verified */}
            <UserAvatar 
              user={authUser} 
              size={36} 
              onSignInPress={() => router.push('/login')}
              onLogout={async () => {
                // Handle logout from editor - just go back to tabs
                router.replace('/(tabs)');
              }}
            />
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

          {/* Content - Simple plain text input */}
          <View style={s.contentContainer}>
            <TextInput
              ref={contentInputRef}
              testID="note-content-input"
              style={s.contentInput}
              value={content}
              onChangeText={handleContentChange}
              multiline
              textAlignVertical="top"
              placeholder="Tap here to start writing..."
              placeholderTextColor={C.borderSub}
              onSelectionChange={(e) => setSelection(e.nativeEvent.selection)}
              autoCorrect={true}
              autoCapitalize="sentences"
            />
          </View>

          {/* Images Section */}
          {images.length > 0 && (
            <View style={s.imagesContainer}>
              <Text style={s.imagesSectionTitle}>Attached Images</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.imagesScroll}>
                {images.map((uri, index) => (
                  <View key={index} style={s.imageWrapper}>
                    <Image source={{ uri }} style={s.attachedImage} />
                    <TouchableOpacity
                      style={s.removeImageBtn}
                      onPress={() => removeImage(index)}
                    >
                      <MaterialIcons name="close" size={16} color={C.primaryFg} />
                    </TouchableOpacity>
                  </View>
                ))}
              </ScrollView>
            </View>
          )}

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
              <TouchableOpacity testID="fmt-bullet" style={s.fmtBtn} onPress={insertBullet}>
                <MaterialIcons name="format-list-bulleted" size={22} color={C.text} />
                <Text style={s.fmtLabel}>List</Text>
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
  contentInput: {
    minHeight: 150,
    backgroundColor: C.surface,
    borderRadius: 12,
    padding: 16,
    borderWidth: 2,
    borderColor: C.borderSub,
    fontSize: 18,
    color: C.text,
    lineHeight: 28,
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
