import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  ScrollView, KeyboardAvoidingView, Platform, Alert, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
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

function formatDate(d: Date): string {
  return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function formatTime(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${m.toString().padStart(2, '0')} ${ampm}`;
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

  // Native picker visibility
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showStartPicker, setShowStartPicker] = useState(false);
  const [showEndPicker, setShowEndPicker] = useState(false);

  // Web fallback state
  const [webStartHour, setWebStartHour] = useState(9);
  const [webStartMin, setWebStartMin] = useState(0);
  const [webEndHour, setWebEndHour] = useState(10);
  const [webEndMin, setWebEndMin] = useState(0);

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
      setWebStartHour(start.getHours());
      setWebStartMin(start.getMinutes());
      setWebEndHour(end.getHours());
      setWebEndMin(end.getMinutes());
    } catch (e) {
      console.error('Failed to load event:', e);
    } finally {
      setLoading(false);
    }
  };

  const onDateChange = (_event: DateTimePickerEvent, selectedDate?: Date) => {
    setShowDatePicker(false);
    if (selectedDate) setDate(selectedDate);
  };

  const onStartTimeChange = (_event: DateTimePickerEvent, selectedDate?: Date) => {
    setShowStartPicker(false);
    if (selectedDate) {
      setStartTime(selectedDate);
      setWebStartHour(selectedDate.getHours());
      setWebStartMin(selectedDate.getMinutes());
    }
  };

  const onEndTimeChange = (_event: DateTimePickerEvent, selectedDate?: Date) => {
    setShowEndPicker(false);
    if (selectedDate) {
      setEndTime(selectedDate);
      setWebEndHour(selectedDate.getHours());
      setWebEndMin(selectedDate.getMinutes());
    }
  };

  // Web fallback helpers
  const adjustWebDate = (days: number) => {
    const newDate = new Date(date);
    newDate.setDate(newDate.getDate() + days);
    setDate(newDate);
  };

  const adjustWebTime = (
    setter: (v: number) => void,
    current: number,
    delta: number,
    max: number,
  ) => {
    let v = current + delta;
    if (v < 0) v = max;
    if (v > max) v = 0;
    setter(v);
  };

  const webFormatHour = (h: number) => {
    const ampm = h >= 12 ? 'PM' : 'AM';
    return `${h % 12 || 12} ${ampm}`;
  };

  const handleSave = async () => {
    if (!title.trim()) {
      Alert.alert('Title Required', 'Please enter a title for the event.');
      return;
    }

    setSaving(true);
    try {
      const st = new Date(date);
      const et = new Date(date);

      if (isWeb) {
        st.setHours(webStartHour, webStartMin, 0, 0);
        et.setHours(webEndHour, webEndMin, 0, 0);
      } else {
        st.setHours(startTime.getHours(), startTime.getMinutes(), 0, 0);
        et.setHours(endTime.getHours(), endTime.getMinutes(), 0, 0);
      }

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

          {/* ---- Date ---- */}
          <Text style={s.label}>Date</Text>
          {isWeb ? (
            <View style={s.webRow}>
              <TouchableOpacity
                testID="date-prev-btn"
                style={s.webAdjBtn}
                onPress={() => adjustWebDate(-1)}
              >
                <MaterialIcons name="chevron-left" size={32} color={C.text} />
              </TouchableOpacity>
              <Text style={s.webValue}>{formatDate(date)}</Text>
              <TouchableOpacity
                testID="date-next-btn"
                style={s.webAdjBtn}
                onPress={() => adjustWebDate(1)}
              >
                <MaterialIcons name="chevron-right" size={32} color={C.text} />
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <TouchableOpacity
                testID="date-picker-btn"
                style={s.pickerBtn}
                onPress={() => setShowDatePicker(true)}
                activeOpacity={0.7}
              >
                <MaterialIcons name="calendar-today" size={24} color={C.secondary} />
                <Text style={s.pickerBtnText}>{formatDate(date)}</Text>
                <MaterialIcons name="arrow-drop-down" size={28} color={C.borderSub} />
              </TouchableOpacity>
              {showDatePicker && (
                <DateTimePicker
                  testID="date-picker"
                  value={date}
                  mode="date"
                  display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                  onChange={onDateChange}
                />
              )}
            </>
          )}

          {/* ---- Start Time ---- */}
          <Text style={s.label}>Start Time</Text>
          {isWeb ? (
            <WebTimePicker
              testPrefix="start"
              hour={webStartHour}
              minute={webStartMin}
              onHourChange={setWebStartHour}
              onMinuteChange={setWebStartMin}
              formatHour={webFormatHour}
            />
          ) : (
            <>
              <TouchableOpacity
                testID="start-time-btn"
                style={s.pickerBtn}
                onPress={() => setShowStartPicker(true)}
                activeOpacity={0.7}
              >
                <MaterialIcons name="access-time" size={24} color={C.secondary} />
                <Text style={s.pickerBtnText}>{formatTime(startTime)}</Text>
                <MaterialIcons name="arrow-drop-down" size={28} color={C.borderSub} />
              </TouchableOpacity>
              {showStartPicker && (
                <DateTimePicker
                  testID="start-time-picker"
                  value={startTime}
                  mode="time"
                  display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                  onChange={onStartTimeChange}
                  minuteInterval={5}
                />
              )}
            </>
          )}

          {/* ---- End Time ---- */}
          <Text style={s.label}>End Time</Text>
          {isWeb ? (
            <WebTimePicker
              testPrefix="end"
              hour={webEndHour}
              minute={webEndMin}
              onHourChange={setWebEndHour}
              onMinuteChange={setWebEndMin}
              formatHour={webFormatHour}
            />
          ) : (
            <>
              <TouchableOpacity
                testID="end-time-btn"
                style={s.pickerBtn}
                onPress={() => setShowEndPicker(true)}
                activeOpacity={0.7}
              >
                <MaterialIcons name="access-time" size={24} color={C.secondary} />
                <Text style={s.pickerBtnText}>{formatTime(endTime)}</Text>
                <MaterialIcons name="arrow-drop-down" size={28} color={C.borderSub} />
              </TouchableOpacity>
              {showEndPicker && (
                <DateTimePicker
                  testID="end-time-picker"
                  value={endTime}
                  mode="time"
                  display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                  onChange={onEndTimeChange}
                  minuteInterval={5}
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

/* ---- Web-only time picker fallback ---- */
function WebTimePicker({
  testPrefix,
  hour,
  minute,
  onHourChange,
  onMinuteChange,
  formatHour,
}: {
  testPrefix: string;
  hour: number;
  minute: number;
  onHourChange: (h: number) => void;
  onMinuteChange: (m: number) => void;
  formatHour: (h: number) => string;
}) {
  const adjH = (d: number) => {
    let v = hour + d;
    if (v < 0) v = 23;
    if (v > 23) v = 0;
    onHourChange(v);
  };
  const adjM = (d: number) => {
    let v = minute + d;
    if (v < 0) v = 45;
    if (v > 45) v = 0;
    onMinuteChange(v);
  };

  return (
    <View style={s.webTimeRow}>
      <View style={s.webTimeUnit}>
        <TouchableOpacity testID={`${testPrefix}-hour-up`} style={s.webTimeBtn} onPress={() => adjH(1)}>
          <MaterialIcons name="keyboard-arrow-up" size={28} color={C.text} />
        </TouchableOpacity>
        <Text style={s.webTimeVal}>{formatHour(hour)}</Text>
        <TouchableOpacity testID={`${testPrefix}-hour-down`} style={s.webTimeBtn} onPress={() => adjH(-1)}>
          <MaterialIcons name="keyboard-arrow-down" size={28} color={C.text} />
        </TouchableOpacity>
      </View>
      <Text style={s.webTimeSep}>:</Text>
      <View style={s.webTimeUnit}>
        <TouchableOpacity testID={`${testPrefix}-min-up`} style={s.webTimeBtn} onPress={() => adjM(15)}>
          <MaterialIcons name="keyboard-arrow-up" size={28} color={C.text} />
        </TouchableOpacity>
        <Text style={s.webTimeVal}>{minute.toString().padStart(2, '0')}</Text>
        <TouchableOpacity testID={`${testPrefix}-min-down`} style={s.webTimeBtn} onPress={() => adjM(-15)}>
          <MaterialIcons name="keyboard-arrow-down" size={28} color={C.text} />
        </TouchableOpacity>
      </View>
    </View>
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

  /* ---- Native picker button ---- */
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

  /* ---- Web fallback date row ---- */
  webRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: C.surface,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: C.borderSub,
    paddingVertical: 8,
  },
  webAdjBtn: {
    width: 56,
    height: 56,
    justifyContent: 'center',
    alignItems: 'center',
  },
  webValue: { fontSize: 22, fontWeight: '600', color: C.text },

  /* ---- Web fallback time picker ---- */
  webTimeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.surface,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: C.borderSub,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  webTimeUnit: { alignItems: 'center', flex: 1 },
  webTimeBtn: {
    width: 56,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  webTimeVal: {
    fontSize: 24,
    fontWeight: '700',
    color: C.text,
    paddingVertical: 4,
  },
  webTimeSep: {
    fontSize: 28,
    fontWeight: '700',
    color: C.text,
    marginHorizontal: 8,
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
