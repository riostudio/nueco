import React, { useState, useEffect, createElement } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  ScrollView, KeyboardAvoidingView, Platform, Alert, ActivityIndicator,
  Switch, Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { eventsApi, notesApi } from '../src/api';
import { MONTH_NAMES } from '../src/theme';
import { ReminderMinutes } from '../src/types';
import { Picker } from '@react-native-picker/picker';

// Import expo-notifications for reminders
let Notifications: typeof import('expo-notifications') | null = null;
if (Platform.OS !== 'web') {
  try {
    Notifications = require('expo-notifications');
  } catch (e) {
    // Not available
  }
}

let ExpoCalendar: typeof import('expo-calendar') | null = null;
if (Platform.OS !== 'web') {
  try {
    ExpoCalendar = require('expo-calendar');
  } catch (e) {
    // Not available
  }
}

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

// Reminder options
const REMINDER_OPTIONS: { label: string; value: ReminderMinutes | null }[] = [
  { label: 'No Reminder', value: null },
  { label: '5 minutes before', value: 5 },
  { label: '15 minutes before', value: 15 },
  { label: '30 minutes before', value: 30 },
  { label: '1 hour before', value: 60 },
  { label: '1 day before', value: 1440 },
];

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
  const [addToDeviceCal, setAddToDeviceCal] = useState(true); // ON by default
  const [reminderMinutes, setReminderMinutes] = useState<ReminderMinutes | null>(15); // Default 15 min reminder
  const [deviceCalendarEventId, setDeviceCalendarEventId] = useState<string | null>(null);

  // Android-only: pickers need show/hide toggle
  const [showAndroidDate, setShowAndroidDate] = useState(false);
  const [showAndroidStart, setShowAndroidStart] = useState(false);
  const [showAndroidEnd, setShowAndroidEnd] = useState(false);

  // Delete confirmation modal state
  const [deleteModalVisible, setDeleteModalVisible] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (isEditing && params.eventId) {
      loadEvent(params.eventId);
    }
    // Request notification permissions on mount
    requestNotificationPermissions();
  }, []);

  const requestNotificationPermissions = async () => {
    if (Notifications && !isWeb) {
      const { status } = await Notifications.requestPermissionsAsync();
      if (status !== 'granted') {
        console.log('Notification permissions not granted');
      }
    }
  };

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
      setReminderMinutes(event.reminder_minutes || null);
      setDeviceCalendarEventId(event.device_calendar_event_id || null);
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

      // Write to device calendar first (if enabled) to get the device calendar event ID
      let newDeviceCalEventId = deviceCalendarEventId;
      if (addToDeviceCal && !isWeb) {
        newDeviceCalEventId = await writeToDeviceCalendar(
          title.trim(),
          description.trim(),
          st,
          et,
          deviceCalendarEventId // Pass existing ID for update
        );
      }

      // Schedule notification reminder
      if (reminderMinutes && !isWeb) {
        await scheduleReminder(title.trim(), st, reminderMinutes);
      }

      const eventData = {
        title: title.trim(),
        description: description.trim(),
        start_time: st.toISOString(),
        end_time: et.toISOString(),
        linked_note_ids: linkedNoteIds,
        reminder_minutes: reminderMinutes,
        device_calendar_event_id: newDeviceCalEventId,
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

  // Schedule a notification reminder before the event
  const scheduleReminder = async (
    eventTitle: string,
    eventStartTime: Date,
    minutesBefore: number
  ) => {
    if (!Notifications || isWeb) return;

    try {
      // Cancel any existing notification for this event
      await Notifications.cancelAllScheduledNotificationsAsync();

      const reminderTime = new Date(eventStartTime.getTime() - minutesBefore * 60 * 1000);
      
      // Only schedule if reminder time is in the future
      if (reminderTime > new Date()) {
        await Notifications.scheduleNotificationAsync({
          content: {
            title: '⏰ Event Reminder',
            body: `"${eventTitle}" starts in ${getReminderLabel(minutesBefore)}`,
            sound: true,
          },
          trigger: {
            type: Notifications.SchedulableTriggerInputTypes.DATE,
            date: reminderTime,
          },
        });
        console.log('Reminder scheduled for:', reminderTime);
      }
    } catch (e) {
      console.error('Failed to schedule reminder:', e);
    }
  };

  const getReminderLabel = (minutes: number): string => {
    const option = REMINDER_OPTIONS.find(o => o.value === minutes);
    return option ? option.label.replace(' before', '') : `${minutes} minutes`;
  };

  const handleDeletePress = () => {
    if (!isEditing || !params.eventId) return;
    setDeleteModalVisible(true);
  };

  const confirmDelete = async () => {
    if (!params.eventId) return;
    setDeleting(true);
    try {
      await eventsApi.delete(params.eventId);
      setDeleteModalVisible(false);
      router.back();
    } catch (e) {
      console.error('Delete failed:', e);
      setDeleting(false);
    }
  };

  const cancelDelete = () => {
    setDeleteModalVisible(false);
  };

  const writeToDeviceCalendar = async (
    eventTitle: string,
    eventDesc: string,
    startDate: Date,
    endDate: Date,
    existingEventId: string | null = null,
  ): Promise<string | null> => {
    if (!ExpoCalendar || isWeb) return null;
    try {
      const { status } = await ExpoCalendar.requestCalendarPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(
          'Calendar Permission',
          'Calendar access is needed to sync events with your device calendar. You can enable it in Settings.',
        );
        return null;
      }

      const calendars = await ExpoCalendar.getCalendarsAsync(
        ExpoCalendar.EntityTypes.EVENT,
      );

      // Find a writable calendar
      let targetCalId: string | undefined;

      if (Platform.OS === 'ios') {
        // Prefer default calendar on iOS
        try {
          const defaultCal = await ExpoCalendar.getDefaultCalendarAsync();
          targetCalId = defaultCal.id;
        } catch {
          const writable = calendars.find(
            (c) => c.allowsModifications && c.source?.type === 'local',
          );
          targetCalId = writable?.id || calendars[0]?.id;
        }
      } else {
        // Android: find a writable calendar (prefer Google, then local)
        const googleCal = calendars.find(
          (c) =>
            c.allowsModifications &&
            c.source?.name?.toLowerCase().includes('google'),
        );
        const writableCal = calendars.find((c) => c.allowsModifications);
        targetCalId = googleCal?.id || writableCal?.id || calendars[0]?.id;
      }

      if (!targetCalId) {
        Alert.alert('No Calendar', 'No writable calendar found on your device.');
        return null;
      }

      const eventDetails = {
        title: eventTitle,
        notes: eventDesc,
        startDate,
        endDate,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };

      let deviceEventId: string | null = null;

      // Try to update existing event, or create new one
      if (existingEventId) {
        try {
          await ExpoCalendar.updateEventAsync(existingEventId, eventDetails);
          deviceEventId = existingEventId;
          console.log('Updated device calendar event:', existingEventId);
        } catch (updateError) {
          // Event might have been deleted from device calendar, create new one
          console.log('Could not update event, creating new one');
          deviceEventId = await ExpoCalendar.createEventAsync(targetCalId, eventDetails);
        }
      } else {
        // Create new event
        deviceEventId = await ExpoCalendar.createEventAsync(targetCalId, eventDetails);
        console.log('Created device calendar event:', deviceEventId);
      }

      return deviceEventId;
    } catch (e) {
      console.error('Device calendar write error:', e);
      Alert.alert('Calendar Error', 'Could not sync event with device calendar.');
      return null;
    }
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

          {/* Add to Device Calendar Toggle - Only show on native platforms */}
          {!isWeb && (
            <View style={s.calendarToggle}>
              <View style={s.calendarToggleLeft}>
                <MaterialIcons 
                  name={Platform.OS === 'ios' ? 'event' : 'event-available'} 
                  size={28} 
                  color={C.secondary} 
                />
                <View style={s.calendarToggleTextContainer}>
                  <Text style={s.calendarToggleTitle}>
                    {Platform.OS === 'ios' ? 'Sync to Apple Calendar' : 'Sync to Google Calendar'}
                  </Text>
                  <Text style={s.calendarToggleSubtitle}>
                    Auto-sync with your device calendar
                  </Text>
                </View>
              </View>
              <Switch
                testID="device-calendar-toggle"
                value={addToDeviceCal}
                onValueChange={setAddToDeviceCal}
                trackColor={{ false: C.borderSub, true: C.secondary + '80' }}
                thumbColor={addToDeviceCal ? C.secondary : '#f4f3f4'}
                ios_backgroundColor={C.borderSub}
              />
            </View>
          )}

          {/* Reminder Picker - Native */}
          <Text style={s.label}>Reminder</Text>
          <View style={s.pickerContainer}>
            <MaterialIcons name="notifications" size={24} color={C.secondary} style={{ marginRight: 8 }} />
            <View style={s.nativePickerWrapper}>
              <Picker
                testID="reminder-native-picker"
                selectedValue={reminderMinutes}
                onValueChange={(value) => setReminderMinutes(value as ReminderMinutes | null)}
                style={s.nativePicker}
                itemStyle={s.pickerItem}
              >
                {REMINDER_OPTIONS.map((option) => (
                  <Picker.Item
                    key={option.label}
                    label={option.label}
                    value={option.value}
                  />
                ))}
              </Picker>
            </View>
          </View>

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
              onPress={handleDeletePress}
            >
              <MaterialIcons name="delete" size={24} color={C.error} />
              <Text style={s.deleteBtnText}>Delete Event</Text>
            </TouchableOpacity>
          )}

          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>

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
            <Text style={s.modalTitle}>Delete Event?</Text>
            <Text style={s.modalMessage}>
              Are you sure you want to delete "{title || 'this event'}"? This action cannot be undone.
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
  calendarToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: C.surface,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: C.secondary + '40',
    padding: 16,
    marginTop: 24,
  },
  calendarToggleLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  calendarToggleTextContainer: {
    marginLeft: 12,
    flex: 1,
  },
  calendarToggleTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: C.text,
  },
  calendarToggleSubtitle: {
    fontSize: 14,
    color: C.textSec,
    marginTop: 2,
  },
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
  // Native Picker styles
  nativePickerWrapper: {
    flex: 1,
    borderWidth: 2,
    borderColor: C.borderSub,
    borderRadius: 12,
    backgroundColor: C.surface,
    overflow: 'hidden',
  },
  nativePicker: {
    height: 50,
    width: '100%',
  },
  pickerItem: {
    fontSize: 18,
    color: C.text,
  },
});
