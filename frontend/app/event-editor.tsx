import React, { useState, useEffect } from 'react';
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
  const [startHour, setStartHour] = useState(9);
  const [startMinute, setStartMinute] = useState(0);
  const [endHour, setEndHour] = useState(10);
  const [endMinute, setEndMinute] = useState(0);
  const [loading, setLoading] = useState(isEditing);
  const [saving, setSaving] = useState(false);

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
      setStartHour(start.getHours());
      setStartMinute(start.getMinutes());
      setEndHour(end.getHours());
      setEndMinute(end.getMinutes());
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
      const startTime = new Date(date);
      startTime.setHours(startHour, startMinute, 0, 0);
      const endTime = new Date(date);
      endTime.setHours(endHour, endMinute, 0, 0);

      if (endTime <= startTime) {
        Alert.alert('Invalid Time', 'End time must be after start time.');
        setSaving(false);
        return;
      }

      const linkedNoteIds = params.noteId && params.noteId !== 'new' ? [params.noteId] : [];

      const eventData = {
        title: title.trim(),
        description: description.trim(),
        start_time: startTime.toISOString(),
        end_time: endTime.toISOString(),
        linked_note_ids: linkedNoteIds,
      };

      if (isEditing && params.eventId) {
        await eventsApi.update(params.eventId, eventData);
      } else {
        const created = await eventsApi.create(eventData);
        // Link event to note if applicable
        if (params.noteId && params.noteId !== 'new') {
          try {
            await notesApi.update(params.noteId, { linked_event_id: created.id });
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

  const adjustDate = (days: number) => {
    const newDate = new Date(date);
    newDate.setDate(newDate.getDate() + days);
    setDate(newDate);
  };

  const adjustTime = (
    setter: (v: number) => void,
    current: number,
    delta: number,
    max: number
  ) => {
    let newVal = current + delta;
    if (newVal < 0) newVal = max;
    if (newVal > max) newVal = 0;
    setter(newVal);
  };

  const formatDisplayDate = (d: Date) =>
    `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;

  const formatHour = (h: number) => {
    const ampm = h >= 12 ? 'PM' : 'AM';
    const hour = h % 12 || 12;
    return `${hour} ${ampm}`;
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
          <TouchableOpacity testID="event-back-btn" style={s.headerBtn} onPress={() => router.back()}>
            <MaterialIcons name="close" size={28} color={C.text} />
            <Text style={s.headerBtnLabel}>Cancel</Text>
          </TouchableOpacity>
          <Text style={s.headerTitle}>{isEditing ? 'Edit Event' : 'New Event'}</Text>
          <View style={{ width: 80 }} />
        </View>

        <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent} keyboardShouldPersistTaps="handled">
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

          {/* Date */}
          <Text style={s.label}>Date</Text>
          <View style={s.dateRow}>
            <TouchableOpacity testID="date-prev-btn" style={s.adjBtn} onPress={() => adjustDate(-1)}>
              <MaterialIcons name="chevron-left" size={32} color={C.text} />
            </TouchableOpacity>
            <Text style={s.dateText}>{formatDisplayDate(date)}</Text>
            <TouchableOpacity testID="date-next-btn" style={s.adjBtn} onPress={() => adjustDate(1)}>
              <MaterialIcons name="chevron-right" size={32} color={C.text} />
            </TouchableOpacity>
          </View>

          {/* Start Time */}
          <Text style={s.label}>Start Time</Text>
          <View style={s.timeRow}>
            <View style={s.timeUnit}>
              <TouchableOpacity
                testID="start-hour-up"
                style={s.timeBtn}
                onPress={() => adjustTime(setStartHour, startHour, 1, 23)}
              >
                <MaterialIcons name="keyboard-arrow-up" size={28} color={C.text} />
              </TouchableOpacity>
              <Text style={s.timeValue}>{formatHour(startHour)}</Text>
              <TouchableOpacity
                testID="start-hour-down"
                style={s.timeBtn}
                onPress={() => adjustTime(setStartHour, startHour, -1, 23)}
              >
                <MaterialIcons name="keyboard-arrow-down" size={28} color={C.text} />
              </TouchableOpacity>
            </View>
            <Text style={s.timeSep}>:</Text>
            <View style={s.timeUnit}>
              <TouchableOpacity
                testID="start-min-up"
                style={s.timeBtn}
                onPress={() => adjustTime(setStartMinute, startMinute, 15, 45)}
              >
                <MaterialIcons name="keyboard-arrow-up" size={28} color={C.text} />
              </TouchableOpacity>
              <Text style={s.timeValue}>{startMinute.toString().padStart(2, '0')}</Text>
              <TouchableOpacity
                testID="start-min-down"
                style={s.timeBtn}
                onPress={() => adjustTime(setStartMinute, startMinute, -15, 45)}
              >
                <MaterialIcons name="keyboard-arrow-down" size={28} color={C.text} />
              </TouchableOpacity>
            </View>
          </View>

          {/* End Time */}
          <Text style={s.label}>End Time</Text>
          <View style={s.timeRow}>
            <View style={s.timeUnit}>
              <TouchableOpacity
                testID="end-hour-up"
                style={s.timeBtn}
                onPress={() => adjustTime(setEndHour, endHour, 1, 23)}
              >
                <MaterialIcons name="keyboard-arrow-up" size={28} color={C.text} />
              </TouchableOpacity>
              <Text style={s.timeValue}>{formatHour(endHour)}</Text>
              <TouchableOpacity
                testID="end-hour-down"
                style={s.timeBtn}
                onPress={() => adjustTime(setEndHour, endHour, -1, 23)}
              >
                <MaterialIcons name="keyboard-arrow-down" size={28} color={C.text} />
              </TouchableOpacity>
            </View>
            <Text style={s.timeSep}>:</Text>
            <View style={s.timeUnit}>
              <TouchableOpacity
                testID="end-min-up"
                style={s.timeBtn}
                onPress={() => adjustTime(setEndMinute, endMinute, 15, 45)}
              >
                <MaterialIcons name="keyboard-arrow-up" size={28} color={C.text} />
              </TouchableOpacity>
              <Text style={s.timeValue}>{endMinute.toString().padStart(2, '0')}</Text>
              <TouchableOpacity
                testID="end-min-down"
                style={s.timeBtn}
                onPress={() => adjustTime(setEndMinute, endMinute, -15, 45)}
              >
                <MaterialIcons name="keyboard-arrow-down" size={28} color={C.text} />
              </TouchableOpacity>
            </View>
          </View>

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

          {/* Actions */}
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
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: C.borderSub + '40',
  },
  headerBtn: { flexDirection: 'row', alignItems: 'center', height: 48 },
  headerBtnLabel: { fontSize: 18, fontWeight: '600', color: C.text, marginLeft: 4 },
  headerTitle: { fontSize: 22, fontWeight: '700', color: C.text },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 24, paddingTop: 24 },
  label: { fontSize: 18, fontWeight: '600', color: C.textSec, marginBottom: 8, marginTop: 16 },
  input: {
    height: 56, borderWidth: 2, borderColor: C.border, borderRadius: 12,
    paddingHorizontal: 16, fontSize: 20, color: C.text, backgroundColor: C.surface,
  },
  dateRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: C.surface, borderRadius: 12, borderWidth: 2, borderColor: C.borderSub,
    paddingVertical: 8,
  },
  adjBtn: { width: 56, height: 56, justifyContent: 'center', alignItems: 'center' },
  dateText: { fontSize: 22, fontWeight: '600', color: C.text },
  timeRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.surface, borderRadius: 12, borderWidth: 2, borderColor: C.borderSub,
    paddingVertical: 8, paddingHorizontal: 16,
  },
  timeUnit: { alignItems: 'center', flex: 1 },
  timeBtn: { width: 56, height: 44, justifyContent: 'center', alignItems: 'center' },
  timeValue: { fontSize: 24, fontWeight: '700', color: C.text, paddingVertical: 4 },
  timeSep: { fontSize: 28, fontWeight: '700', color: C.text, marginHorizontal: 8 },
  descInput: {
    minHeight: 100, borderWidth: 2, borderColor: C.border, borderRadius: 12,
    paddingHorizontal: 16, paddingTop: 12, fontSize: 20, color: C.text,
    backgroundColor: C.surface, textAlignVertical: 'top',
  },
  linkedNote: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.secondary + '15', borderRadius: 8,
    padding: 12, marginTop: 16,
  },
  linkedNoteText: { fontSize: 16, color: C.secondary, marginLeft: 8, flex: 1 },
  saveBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.primary, borderRadius: 16, height: 64, marginTop: 24,
  },
  saveBtnText: { fontSize: 20, fontWeight: '600', color: C.primaryFg, marginLeft: 8 },
  deleteBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: C.error, borderRadius: 16, height: 64, marginTop: 12,
  },
  deleteBtnText: { fontSize: 20, fontWeight: '600', color: C.error, marginLeft: 8 },
});
