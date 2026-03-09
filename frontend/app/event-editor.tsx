import React, { useState, useEffect, createElement } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  ScrollView, KeyboardAvoidingView, Platform, Alert, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { eventsApi, notesApi } from '../src/api';
import { MONTH_NAMES } from '../src/theme';

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
  error: '#C62828',
};

const isWeb = Platform.OS === 'web';

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function toDateString(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function toTimeString(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatDisplayDate(d: Date): string {
  return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function formatDisplayTime(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${pad2(m)} ${ampm}`;
}

/* ---- Native HTML inputs for web (triggers OS pickers on mobile browsers) ---- */

function NativeDateInput({
  value,
  onChange,
  testID,
}: {
  value: Date;
  onChange: (d: Date) => void;
  testID: string;
}) {
  if (!isWeb) return null;

  return createElement('input', {
    type: 'date',
    value: toDateString(value),
    'data-testid': testID,
    onChange: (e: any) => {
      const parts = e.target.value.split('-');
      if (parts.length === 3) {
        onChange(new Date(+parts[0], +parts[1] - 1, +parts[2]));
      }
    },
    style: {
      width: '100%',
      height: 60,
      fontSize: 22,
      fontWeight: '600',
      padding: '0 16px',
      border: '2px solid #78909C',
      borderRadius: 12,
      backgroundColor: '#FFFFFF',
      color: '#121212',
      fontFamily: 'inherit',
      boxSizing: 'border-box',
      WebkitAppearance: 'none',
      appearance: 'none',
    },
  });
}

function NativeTimeInput({
  value,
  onChange,
  testID,
}: {
  value: Date;
  onChange: (d: Date) => void;
  testID: string;
}) {
  if (!isWeb) return null;

  return createElement('input', {
    type: 'time',
    value: toTimeString(value),
    'data-testid': testID,
    step: 300, // 5 minute intervals
    onChange: (e: any) => {
      const parts = e.target.value.split(':');
      if (parts.length >= 2) {
        const newDate = new Date(value);
        newDate.setHours(+parts[0], +parts[1], 0, 0);
        onChange(newDate);
      }
    },
    style: {
      width: '100%',
      height: 60,
      fontSize: 22,
      fontWeight: '600',
      padding: '0 16px',
      border: '2px solid #78909C',
      borderRadius: 12,
      backgroundColor: '#FFFFFF',
      color: '#121212',
      fontFamily: 'inherit',
      boxSizing: 'border-box',
      WebkitAppearance: 'none',
      appearance: 'none',
    },
  });
}

/* ---- Native DateTimePicker for Expo Go (iOS/Android) ---- */

let DateTimePicker: any = null;
if (!isWeb) {
  try {
    DateTimePicker =
      require('@react-native-community/datetimepicker').default;
  } catch (e) {
    // Fallback silently if not available
  }
}

export default function EventEditorScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    eventId?: string;
    date?: string;
    noteId?: string;
    noteTitle?: string;
  }>();

  const isEditing = !!params.eventId;
  const initialDate = params.date ? new Date(params.date) : new Date();

  const [title, setTitle] = useState(params.noteTitle || '');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(initialDate);
  const [startTime, setStartTime] = useState(() => {
    const d = new Date(initialDate);
    d.setHours(9, 0, 0, 0);
    return d;
  });
  const [endTime, setEndTime] = useState(() => {
    const d = new Date(initialDate);
    d.setHours(10, 0, 0, 0);
    return d;
  });
  const [loading, setLoading] = useState(isEditing);
  const [saving, setSaving] = useState(false);

  // Android-only: pickers need show/hide toggle
  const [showAndroidDate, setShowAndroidDate] = useState(false);
  const [showAndroidStart, setShowAndroidStart] = useState(false);
  const [showAndroidEnd, setShowAndroidEnd] = useState(false);

  useEffect(() => {
    if (isEditing && params.eventId) {
      loadEvent(params.eventId);
    }
  }, []);

  const loadEvent = async (id: string) => {
    try {
      const event = await eventsApi.get(id);
      setTitle(event.title);
      setDescription(event.description);
      const start = new Date(event.start_time);
      const end = new Date(event.end_time);
      setDate(start);
      setStartTime(start);
      setEndTime(end);
    } catch (e) {
      console.error('Failed to load event:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!title.trim()) {
      Alert.alert('Title Required', 'Please enter a title for the event.');
      return;
    }

    setSaving(true);
    try {
      const st = new Date(date);
      st.setHours(startTime.getHours(), startTime.getMinutes(), 0, 0);
      const et = new Date(date);
      et.setHours(endTime.getHours(), endTime.getMinutes(), 0, 0);

      if (et <= st) {
        Alert.alert('Invalid Time', 'End time must be after start time.');
        setSaving(false);
        return;
      }

      const linkedNoteIds =
        params.noteId && params.noteId !== 'new' ? [params.noteId] : [];

      const eventData = {
        title: title.trim(),
        description: description.trim(),
        start_time: st.toISOString(),
        end_time: et.toISOString(),
        linked_note_ids: linkedNoteIds,
      };

      if (isEditing && params.eventId) {
        await eventsApi.update(params.eventId, eventData);
      } else {
        const created = await eventsApi.create(eventData);
        if (params.noteId && params.noteId !== 'new') {
          try {
            await notesApi.update(params.noteId, {
              linked_event_id: created.id,
            });
          } catch (e) {
            console.error('Failed to link event to note:', e);
          }
        }
      }
      router.back();
    } catch (e) {
      Alert.alert('Error', 'Failed to save event. Please try again.');
      console.error('Save event error:', e);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = () => {
    if (!isEditing || !params.eventId) return;
    Alert.alert('Delete Event', 'Are you sure you want to delete this event?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await eventsApi.delete(params.eventId!);
            router.back();
          } catch (e) {
            Alert.alert('Error', 'Failed to delete event.');
          }
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

  const isIOS = Platform.OS === 'ios';
  const isAndroid = Platform.OS === 'android';

  return (
    <SafeAreaView style={s.container}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {/* Header */}
        <View style={s.header}>
          <TouchableOpacity
            testID="event-back-btn"
            style={s.headerBtn}
            onPress={() => router.back()}
          >
            <MaterialIcons name="close" size={28} color={C.text} />
            <Text style={s.headerBtnLabel}>Cancel</Text>
          </TouchableOpacity>
          <Text style={s.headerTitle}>
            {isEditing ? 'Edit Event' : 'New Event'}
          </Text>
          <View style={{ width: 80 }} />
        </View>

        <ScrollView
          style={s.scroll}
          contentContainerStyle={s.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {/* Title */}
          <Text style={s.label}>Event Title</Text>
          <TextInput
            testID="event-title-input"
            style={s.input}
            placeholder="Enter event title..."
            placeholderTextColor={C.borderSub}
            value={title}
            onChangeText={setTitle}
          />

          {/* ======== DATE ======== */}
          <Text style={s.label}>Date</Text>

          {isWeb && (
            <NativeDateInput
              testID="native-date-input"
              value={date}
              onChange={setDate}
            />
          )}

          {isIOS && DateTimePicker && (
            <View style={s.pickerContainer}>
              <DateTimePicker
                testID="ios-date-picker"
                value={date}
                mode="date"
                display="spinner"
                onChange={(_e: any, d?: Date) => d && setDate(d)}
                style={{ height: 150 }}
                textColor={C.text}
              />
            </View>
          )}

          {isAndroid && (
            <>
              <TouchableOpacity
                testID="android-date-btn"
                style={s.pickerBtn}
                onPress={() => setShowAndroidDate(true)}
              >
                <MaterialIcons
                  name="calendar-today"
                  size={24}
                  color={C.secondary}
                />
                <Text style={s.pickerBtnText}>{formatDisplayDate(date)}</Text>
                <MaterialIcons
                  name="arrow-drop-down"
                  size={28}
                  color={C.borderSub}
                />
              </TouchableOpacity>
              {showAndroidDate && DateTimePicker && (
                <DateTimePicker
                  testID="android-date-picker"
                  value={date}
                  mode="date"
                  display="default"
                  onChange={(_e: any, d?: Date) => {
                    setShowAndroidDate(false);
                    if (d) setDate(d);
                  }}
                />
              )}
            </>
          )}

          {/* ======== START TIME ======== */}
          <Text style={s.label}>Start Time</Text>

          {isWeb && (
            <NativeTimeInput
              testID="native-start-time"
              value={startTime}
              onChange={setStartTime}
            />
          )}

          {isIOS && DateTimePicker && (
            <View style={s.pickerContainer}>
              <DateTimePicker
                testID="ios-start-picker"
                value={startTime}
                mode="time"
                display="spinner"
                onChange={(_e: any, d?: Date) => d && setStartTime(d)}
                minuteInterval={5}
                style={{ height: 150 }}
                textColor={C.text}
              />
            </View>
          )}

          {isAndroid && (
            <>
              <TouchableOpacity
                testID="android-start-btn"
                style={s.pickerBtn}
                onPress={() => setShowAndroidStart(true)}
              >
                <MaterialIcons
                  name="access-time"
                  size={24}
                  color={C.secondary}
                />
                <Text style={s.pickerBtnText}>
                  {formatDisplayTime(startTime)}
                </Text>
                <MaterialIcons
                  name="arrow-drop-down"
                  size={28}
                  color={C.borderSub}
                />
              </TouchableOpacity>
              {showAndroidStart && DateTimePicker && (
                <DateTimePicker
                  testID="android-start-picker"
                  value={startTime}
                  mode="time"
                  display="default"
                  minuteInterval={5}
                  onChange={(_e: any, d?: Date) => {
                    setShowAndroidStart(false);
                    if (d) setStartTime(d);
                  }}
                />
              )}
            </>
          )}

          {/* ======== END TIME ======== */}
          <Text style={s.label}>End Time</Text>

          {isWeb && (
            <NativeTimeInput
              testID="native-end-time"
              value={endTime}
              onChange={setEndTime}
            />
          )}

          {isIOS && DateTimePicker && (
            <View style={s.pickerContainer}>
              <DateTimePicker
                testID="ios-end-picker"
                value={endTime}
                mode="time"
                display="spinner"
                onChange={(_e: any, d?: Date) => d && setEndTime(d)}
                minuteInterval={5}
                style={{ height: 150 }}
                textColor={C.text}
              />
            </View>
          )}

          {isAndroid && (
            <>
              <TouchableOpacity
                testID="android-end-btn"
                style={s.pickerBtn}
                onPress={() => setShowAndroidEnd(true)}
              >
                <MaterialIcons
                  name="access-time"
                  size={24}
                  color={C.secondary}
                />
                <Text style={s.pickerBtnText}>
                  {formatDisplayTime(endTime)}
                </Text>
                <MaterialIcons
                  name="arrow-drop-down"
                  size={28}
                  color={C.borderSub}
                />
              </TouchableOpacity>
              {showAndroidEnd && DateTimePicker && (
                <DateTimePicker
                  testID="android-end-picker"
                  value={endTime}
                  mode="time"
                  display="default"
                  minuteInterval={5}
                  onChange={(_e: any, d?: Date) => {
                    setShowAndroidEnd(false);
                    if (d) setEndTime(d);
                  }}
                />
              )}
            </>
          )}

          {/* Description */}
          <Text style={s.label}>Description (optional)</Text>
          <TextInput
            testID="event-desc-input"
            style={s.descInput}
            placeholder="Add a description..."
            placeholderTextColor={C.borderSub}
            value={description}
            onChangeText={setDescription}
            multiline
            textAlignVertical="top"
          />

          {/* Linked Note Indicator */}
          {params.noteId && params.noteId !== 'new' && (
            <View style={s.linkedNote}>
              <MaterialIcons name="link" size={20} color={C.secondary} />
              <Text style={s.linkedNoteText}>
                Will be linked to note: {params.noteTitle || 'Untitled'}
              </Text>
            </View>
          )}

          {/* Save */}
          <TouchableOpacity
            testID="save-event-btn"
            style={s.saveBtn}
            onPress={handleSave}
            disabled={saving}
            activeOpacity={0.8}
          >
            {saving ? (
              <ActivityIndicator size="small" color={C.primaryFg} />
            ) : (
              <>
                <MaterialIcons name="check" size={24} color={C.primaryFg} />
                <Text style={s.saveBtnText}>
                  {isEditing ? 'Update Event' : 'Create Event'}
                </Text>
              </>
            )}
          </TouchableOpacity>

          {isEditing && (
            <TouchableOpacity
              testID="delete-event-btn"
              style={s.deleteBtn}
              onPress={handleDelete}
            >
              <MaterialIcons name="delete" size={24} color={C.error} />
              <Text style={s.deleteBtnText}>Delete Event</Text>
            </TouchableOpacity>
          )}

          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: C.borderSub + '40',
  },
  headerBtn: { flexDirection: 'row', alignItems: 'center', height: 48 },
  headerBtnLabel: {
    fontSize: 18,
    fontWeight: '600',
    color: C.text,
    marginLeft: 4,
  },
  headerTitle: { fontSize: 22, fontWeight: '700', color: C.text },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 24, paddingTop: 24 },
  label: {
    fontSize: 18,
    fontWeight: '600',
    color: C.textSec,
    marginBottom: 8,
    marginTop: 20,
  },
  input: {
    height: 56,
    borderWidth: 2,
    borderColor: C.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    fontSize: 20,
    color: C.text,
    backgroundColor: C.surface,
  },

  /* Native picker inline container (iOS) */
  pickerContainer: {
    backgroundColor: C.surface,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: C.borderSub,
    overflow: 'hidden',
  },

  /* Android button to open native dialog */
  pickerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.surface,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: C.borderSub,
    paddingHorizontal: 16,
    height: 60,
  },
  pickerBtnText: {
    flex: 1,
    fontSize: 22,
    fontWeight: '600',
    color: C.text,
    marginLeft: 12,
  },

  descInput: {
    minHeight: 100,
    borderWidth: 2,
    borderColor: C.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingTop: 12,
    fontSize: 20,
    color: C.text,
    backgroundColor: C.surface,
    textAlignVertical: 'top',
  },
  linkedNote: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.secondary + '15',
    borderRadius: 8,
    padding: 12,
    marginTop: 16,
  },
  linkedNoteText: {
    fontSize: 16,
    color: C.secondary,
    marginLeft: 8,
    flex: 1,
  },
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.primary,
    borderRadius: 16,
    height: 64,
    marginTop: 24,
  },
  saveBtnText: {
    fontSize: 20,
    fontWeight: '600',
    color: C.primaryFg,
    marginLeft: 8,
  },
  deleteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: C.error,
    borderRadius: 16,
    height: 64,
    marginTop: 12,
  },
  deleteBtnText: {
    fontSize: 20,
    fontWeight: '600',
    color: C.error,
    marginLeft: 8,
  },
});
