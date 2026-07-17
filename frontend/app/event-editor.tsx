import React, { useState, useEffect, createElement, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  ScrollView, KeyboardAvoidingView, Platform, Alert, ActivityIndicator,
  Switch, Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { eventsApi, notesApi } from '../src/api';
import { decryptEventFromServer } from '../src/crypto/eventCrypto';
import { createEventOffline, updateEventOffline, deleteEventOffline, getLocalEvents, setLocalEventNotificationId } from '../src/offlineSync';
import { bumpDeviceCalendarSync } from '../src/deviceCalendarSync';
import { nextOccurrenceOnOrAfter } from '../src/recurrence';
import { MONTH_NAMES, DAY_NAMES, C, radius, borderWidth } from '../src/theme';
import { ReminderMinutes, Recurrence, RecurrenceFreq, CalendarEvent } from '../src/types';
import { Button } from '../src/components';

// `isSynced` = false means the calendar is local-only (Android's `source.isLocalAccount`, or
// iOS's SourceType.LOCAL "On My iPhone") - an event written there never leaves this device, so
// it can't reach Google/Outlook/iCloud, let alone another device signed into the same account.
type DeviceCalendar = { id: string; title: string; source?: string; isSynced: boolean };

// ---- Lazy imports ----

let Notifications: typeof import('expo-notifications') | null = null;
if (Platform.OS !== 'web') {
  try { Notifications = require('expo-notifications'); } catch {}
}

let ExpoCalendar: typeof import('expo-calendar') | null = null;
if (Platform.OS !== 'web') {
  try { ExpoCalendar = require('expo-calendar'); } catch {}
}

let DateTimePicker: any = null;
if (Platform.OS !== 'web') {
  try { DateTimePicker = require('@react-native-community/datetimepicker').default; } catch {}
}

let ExpoLocation: typeof import('expo-location') | null = null;
if (Platform.OS !== 'web') {
  try { ExpoLocation = require('expo-location'); } catch {}
}

// ---- Constants ----

const isWeb = Platform.OS === 'web';

// A device calendar event, trimmed down to what the import picker needs to display + prefill.
type DeviceEventLite = {
  id: string;
  title: string;
  notes: string;
  location: string;
  startDate: string | Date;
  endDate: string | Date;
  allDay: boolean;
  calendarTitle: string;
};

const REMINDER_OPTIONS: { label: string; value: ReminderMinutes | null }[] = [
  { label: 'No Reminder', value: null },
  { label: '5 minutes before', value: 5 },
  { label: '15 minutes before', value: 15 },
  { label: '30 minutes before', value: 30 },
  { label: '1 hour before', value: 60 },
  { label: '1 day before', value: 1440 },
];

type RecurrenceFreqOption = 'none' | RecurrenceFreq;

const RECURRENCE_OPTIONS: { label: string; value: RecurrenceFreqOption }[] = [
  { label: 'Does not repeat', value: 'none' },
  { label: 'Daily', value: 'daily' },
  { label: 'Weekly', value: 'weekly' },
  { label: 'Monthly', value: 'monthly' },
  { label: 'Yearly', value: 'yearly' },
];

// ---- Utility functions ----

function pad2(n: number): string { return n.toString().padStart(2, '0'); }
function toDateString(d: Date): string { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function toTimeString(d: Date): string { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function formatDisplayDate(d: Date): string { return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`; }
function formatDisplayTime(d: Date): string {
  const h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${pad2(d.getMinutes())} ${ampm}`;
}
function addOneHour(d: Date): Date {
  const result = new Date(d);
  result.setHours(d.getHours() + 1, d.getMinutes(), 0, 0);
  return result;
}

// ---- Web input components ----

function NativeDateInput({ value, onChange, testID }: { value: Date; onChange: (d: Date) => void; testID: string }) {
  if (!isWeb) return null;
  return createElement('input', {
    type: 'date',
    value: toDateString(value),
    'data-testid': testID,
    onChange: (e: any) => {
      const parts = e.target.value.split('-');
      if (parts.length === 3) onChange(new Date(+parts[0], +parts[1] - 1, +parts[2]));
    },
    style: { width: '100%', height: 60, fontSize: 20, padding: '0 16px', border: '2px solid #78909C', borderRadius: 12, backgroundColor: '#FFFFFF', color: '#121212', fontFamily: 'inherit', boxSizing: 'border-box' },
  });
}

function NativeTimeInput({ value, onChange, testID }: { value: Date; onChange: (d: Date) => void; testID: string }) {
  if (!isWeb) return null;
  return createElement('input', {
    type: 'time',
    value: toTimeString(value),
    'data-testid': testID,
    step: 300,
    onChange: (e: any) => {
      const parts = e.target.value.split(':');
      if (parts.length >= 2) {
        const newDate = new Date(value);
        newDate.setHours(+parts[0], +parts[1], 0, 0);
        onChange(newDate);
      }
    },
    style: { width: '100%', height: 60, fontSize: 20, padding: '0 16px', border: '2px solid #78909C', borderRadius: 12, backgroundColor: '#FFFFFF', color: '#121212', fontFamily: 'inherit', boxSizing: 'border-box' },
  });
}

// ---- Main Component ----

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

  // State
  const [title, setTitle] = useState(params.noteTitle || '');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [date, setDate] = useState(initialDate);
  const [endDate, setEndDate] = useState(initialDate);
  const [startTime, setStartTime] = useState(() => new Date());
  const [endTime, setEndTime] = useState(() => addOneHour(new Date()));
  const [loading, setLoading] = useState(isEditing);
  const [saveStatus, setSaveStatus] = useState('');
  const [showSuccessOverlay, setShowSuccessOverlay] = useState(false);
  const [addToDeviceCal, setAddToDeviceCal] = useState(true);
  const [reminderMinutes, setReminderMinutes] = useState<ReminderMinutes | null>(15);
  const [deviceCalendarEventId, setDeviceCalendarEventId] = useState<string | null>(null);
  const [localNotificationId, setLocalNotificationId] = useState<string | null>(null);
  const [recurrenceFreq, setRecurrenceFreq] = useState<RecurrenceFreqOption>('none');
  const [recurrenceDays, setRecurrenceDays] = useState<number[]>([]);
  const [recurrenceUntil, setRecurrenceUntil] = useState<Date | null>(null);
  const [showReminderPicker, setShowReminderPicker] = useState(false);
  const [showRecurrencePicker, setShowRecurrencePicker] = useState(false);
  const [showRecurrenceUntilPicker, setShowRecurrenceUntilPicker] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showEndDatePicker, setShowEndDatePicker] = useState(false);
  const [showStartPicker, setShowStartPicker] = useState(false);
  const [showEndPicker, setShowEndPicker] = useState(false);
  const [deleteModalVisible, setDeleteModalVisible] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [eventExists, setEventExists] = useState(isEditing);
  // Device-calendar picker: the user's writable calendars + their chosen target (persisted).
  const [calendars, setCalendars] = useState<DeviceCalendar[]>([]);
  const [preferredCalendarId, setPreferredCalendarId] = useState<string | null>(null);
  const [showCalendarPicker, setShowCalendarPicker] = useState(false);
  // Import-from-device picker: browse existing device calendar events to prefill a new MemoPad event.
  const [showImportPicker, setShowImportPicker] = useState(false);
  const [importLoading, setImportLoading] = useState(false);
  const [importEvents, setImportEvents] = useState<DeviceEventLite[]>([]);
  const [importSearch, setImportSearch] = useState('');
  const [fetchingLocation, setFetchingLocation] = useState(false);

  // Refs
  const eventIdRef = useRef(isEditing ? (params.eventId || '') : '');
  const isCreatedRef = useRef(isEditing);
  const titleRef = useRef(title);
  const descriptionRef = useRef(description);
  const locationRef = useRef(location);
  const dateRef = useRef(date);
  const endDateRef = useRef(endDate);
  const startTimeRef = useRef(startTime);
  const endTimeRef = useRef(endTime);
  const reminderMinutesRef = useRef(reminderMinutes);
  const deviceCalendarEventIdRef = useRef(deviceCalendarEventId);
  const localNotificationIdRef = useRef(localNotificationId);
  const recurrenceFreqRef = useRef(recurrenceFreq);
  const recurrenceDaysRef = useRef(recurrenceDays);
  const recurrenceUntilRef = useRef(recurrenceUntil);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedDataRef = useRef<string>(''); // Track last saved data to avoid duplicate saves
  const calendarsRef = useRef<DeviceCalendar[]>([]); // cached writable calendars
  const preferredCalendarIdRef = useRef<string | null>(null);

  // Sync refs with state
  useEffect(() => { titleRef.current = title; }, [title]);
  useEffect(() => { descriptionRef.current = description; }, [description]);
  useEffect(() => { locationRef.current = location; }, [location]);
  useEffect(() => { dateRef.current = date; }, [date]);
  useEffect(() => { endDateRef.current = endDate; }, [endDate]);
  useEffect(() => { startTimeRef.current = startTime; }, [startTime]);
  useEffect(() => { endTimeRef.current = endTime; }, [endTime]);
  useEffect(() => { reminderMinutesRef.current = reminderMinutes; }, [reminderMinutes]);
  useEffect(() => { deviceCalendarEventIdRef.current = deviceCalendarEventId; }, [deviceCalendarEventId]);
  useEffect(() => { localNotificationIdRef.current = localNotificationId; }, [localNotificationId]);
  useEffect(() => { recurrenceFreqRef.current = recurrenceFreq; }, [recurrenceFreq]);
  useEffect(() => { recurrenceDaysRef.current = recurrenceDays; }, [recurrenceDays]);
  useEffect(() => { recurrenceUntilRef.current = recurrenceUntil; }, [recurrenceUntil]);
  useEffect(() => { preferredCalendarIdRef.current = preferredCalendarId; }, [preferredCalendarId]);

  useEffect(() => {
    if (isEditing && params.eventId) loadEvent(params.eventId);
    requestNotificationPermissions();
    (async () => {
      try {
        const AsyncStorage = require('@react-native-async-storage/async-storage').default;
        const saved = await AsyncStorage.getItem('preferred_calendar_id');
        if (saved) setPreferredCalendarId(saved);
      } catch {}
      loadCalendars(); // silent - populates the picker if calendar permission is already granted
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Changing the start date shifts the end date by the same number of days, so a multi-day
  // event's span is preserved instead of collapsing back to a single day.
  const handleStartDateChange = (d: Date) => {
    const dayDiffMs = endDateRef.current.getTime() - dateRef.current.getTime();
    setDate(d);
    setEndDate(new Date(d.getTime() + dayDiffMs));
  };

  // Fills the Location field from the device's actual GPS position via reverse-geocoding. Not
  // typeahead search suggestions (no places/autocomplete API is wired up in this app) - a one-shot
  // "use where I am right now" fill.
  const useCurrentLocation = async () => {
    if (!ExpoLocation || isWeb) return;
    setFetchingLocation(true);
    try {
      const { status } = await ExpoLocation.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Location', 'Location access is needed to use your current location. You can enable access in Settings.');
        return;
      }
      const pos = await ExpoLocation.getCurrentPositionAsync({ accuracy: ExpoLocation.Accuracy.Balanced });
      const [place] = await ExpoLocation.reverseGeocodeAsync({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
      });
      if (!place) {
        Alert.alert('Location', 'Could not determine your address from your current location.');
        return;
      }
      const line1 = place.name || [place.streetNumber, place.street].filter(Boolean).join(' ');
      const formatted = [line1, place.city, place.region].filter(Boolean).join(', ');
      setLocation(formatted);
    } catch (e) {
      console.error('Failed to get current location:', e);
      Alert.alert('Location', 'Could not get your current location. Please try again.');
    } finally {
      setFetchingLocation(false);
    }
  };

  // ---- API calls ----

  const requestNotificationPermissions = async () => {
    if (Notifications && !isWeb) {
      const { status } = await Notifications.requestPermissionsAsync();
      if (status !== 'granted') console.log('Notification permissions not granted');
    }
  };

  const loadEvent = async (id: string) => {
    try {
      const event = await decryptEventFromServer(await eventsApi.get(id));
      setTitle(event.title);
      setDescription(event.description);
      setLocation(event.location || '');
      const start = new Date(event.start_time);
      const end = new Date(event.end_time);
      setDate(start);
      setEndDate(end);
      setStartTime(start);
      setEndTime(end);
      setReminderMinutes(event.reminder_minutes || null);
      setDeviceCalendarEventId(event.device_calendar_event_id || null);
      if (event.recurrence) {
        setRecurrenceFreq(event.recurrence.freq);
        setRecurrenceDays(event.recurrence.byweekday || []);
        setRecurrenceUntil(event.recurrence.until ? new Date(event.recurrence.until) : null);
      } else {
        setRecurrenceFreq('none');
        setRecurrenceDays([]);
        setRecurrenceUntil(null);
      }
      eventIdRef.current = event.id;
      isCreatedRef.current = true;
      setEventExists(true);

      // `local_notification_id` is device-local-only (never returned by the server) - read it
      // from the local cache, which `fullSync`'s merge (offlineSync.ts) preserves across refreshes.
      try {
        const locals = await getLocalEvents();
        const localMatch = locals.find((e) => e.id === event.id);
        if (localMatch?.local_notification_id) {
          setLocalNotificationId(localMatch.local_notification_id);
          localNotificationIdRef.current = localMatch.local_notification_id;
        }
      } catch {}
    } catch (e) {
      console.error('Failed to load event:', e);
    } finally {
      setLoading(false);
    }
  };

  // ---- Calendar functions ----

  // Load + cache the device's writable calendars. Silent by default (won't prompt for permission);
  // pass { prompt: true } to request it (from the picker and on write). { force: true } refetches.
  const loadCalendars = useCallback(async (opts: { prompt?: boolean; force?: boolean } = {}) => {
    if (!ExpoCalendar || isWeb) return [] as DeviceCalendar[];
    if (calendarsRef.current.length && !opts.force) return calendarsRef.current;
    try {
      let status = (await ExpoCalendar.getCalendarPermissionsAsync()).status;
      if (status !== 'granted') {
        if (!opts.prompt) return [];
        status = (await ExpoCalendar.requestCalendarPermissionsAsync()).status;
        if (status !== 'granted') return [];
      }
      const all = await ExpoCalendar.getCalendarsAsync(ExpoCalendar.EntityTypes.EVENT);
      const writable = all
        .filter((c: any) => c.allowsModifications)
        .map((c: any) => ({
          id: c.id as string,
          title: c.title as string,
          source: c.source?.name as string | undefined,
          isSynced: Platform.OS === 'android' ? c.source?.isLocalAccount !== true : c.source?.type !== 'local',
        }));
      calendarsRef.current = writable;
      setCalendars(writable);
      return writable;
    } catch (e) {
      console.error('Failed to load calendars:', e);
      return [];
    }
  }, []);

  const selectCalendar = async (id: string | null) => {
    setPreferredCalendarId(id);
    preferredCalendarIdRef.current = id;
    setShowCalendarPicker(false);
    try {
      const AsyncStorage = require('@react-native-async-storage/async-storage').default;
      if (id) await AsyncStorage.setItem('preferred_calendar_id', id);
      else await AsyncStorage.removeItem('preferred_calendar_id');
    } catch {}
  };

  // Browse device calendar events (all calendars, not just writable ones) so the user can pick one
  // to prefill a new MemoPad event from - the reverse of writeToDeviceCalendar's export direction.
  const openImportPicker = async () => {
    if (!ExpoCalendar || isWeb) return;
    setShowImportPicker(true);
    setImportLoading(true);
    try {
      let status = (await ExpoCalendar.getCalendarPermissionsAsync()).status;
      if (status !== 'granted') {
        status = (await ExpoCalendar.requestCalendarPermissionsAsync()).status;
      }
      if (status !== 'granted') {
        setShowImportPicker(false);
        Alert.alert('Calendar', 'Calendar access is needed to import events. You can enable access in Settings.');
        return;
      }
      const allCals = await ExpoCalendar.getCalendarsAsync(ExpoCalendar.EntityTypes.EVENT);
      const calIds = allCals.map((c: any) => c.id);
      const calNameById = new Map(allCals.map((c: any) => [c.id, c.title as string]));
      const rangeStart = new Date(); rangeStart.setDate(rangeStart.getDate() - 1);
      const rangeEnd = new Date(); rangeEnd.setDate(rangeEnd.getDate() + 90);
      const events = await ExpoCalendar.getEventsAsync(calIds, rangeStart, rangeEnd);
      const mapped: DeviceEventLite[] = events
        .map((e: any) => ({
          id: e.id,
          title: e.title || 'Untitled',
          notes: e.notes || '',
          location: e.location || '',
          startDate: e.startDate,
          endDate: e.endDate,
          allDay: !!e.allDay,
          calendarTitle: calNameById.get(e.calendarId) || '',
        }))
        .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());
      setImportEvents(mapped);
    } catch (e) {
      console.error('Failed to load device events:', e);
      Alert.alert('Calendar', 'Could not load calendar events.');
    } finally {
      setImportLoading(false);
    }
  };

  const selectImportEvent = (ev: DeviceEventLite) => {
    setTitle(ev.title);
    setDescription(ev.notes);
    setLocation(ev.location);
    const st = new Date(ev.startDate);
    let et = new Date(ev.endDate);
    if (et <= st) et = addOneHour(st);
    setDate(st);
    setEndDate(et);
    setStartTime(st);
    setEndTime(et);
    setDeviceCalendarEventId(ev.id);
    deviceCalendarEventIdRef.current = ev.id;
    setAddToDeviceCal(true);
    setShowImportPicker(false);
  };

  const writeToDeviceCalendar = async (
    eventTitle: string,
    eventDesc: string,
    eventLoc: string,
    startDate: Date,
    endDate: Date,
    existingEventId: string | null = null,
    recurrence: Recurrence | null = null,
    recurrenceTimezone: string | null = null,
  ): Promise<string | null> => {
    if (!ExpoCalendar || isWeb) return null;
    try {
      const cals = await loadCalendars({ prompt: true });
      if (!cals.length) {
        Alert.alert('Calendar', 'Calendar access is needed, or no writable calendar was found. You can enable access in Settings.');
        return null;
      }

      // Prefer the user-chosen calendar (if it still exists + is writable); else the platform default.
      let targetCalId: string | undefined =
        (preferredCalendarIdRef.current && cals.some(c => c.id === preferredCalendarIdRef.current))
          ? preferredCalendarIdRef.current
          : undefined;
      if (!targetCalId) {
        if (Platform.OS === 'ios') {
          // Respects whatever the user set as their device default (that's their own call - if
          // they deliberately default to "On My iPhone", don't second-guess it).
          try { targetCalId = (await ExpoCalendar.getDefaultCalendarAsync()).id; }
          catch { targetCalId = cals[0]?.id; }
        } else {
          // Android has no per-device "default calendar" API to defer to, so prefer any
          // account-synced calendar (Google, Outlook/Exchange, etc. - not just Google by name)
          // over the bare first-writable fallback: a local-only calendar never leaves this
          // device, so an event written there can't reach another device at all.
          const synced = cals.find(c => c.isSynced);
          targetCalId = synced?.id || cals[0]?.id;
        }
      }

      if (!targetCalId) {
        Alert.alert('No Calendar', 'No writable calendar found on your device.');
        return null;
      }

      // For a recurring event, the device-calendar entry is a plain one-off that always
      // points at the *upcoming* occurrence rather than the event's original start_time -
      // not a native recurrenceRule (deliberately avoided, see recurrence.ts's header comment
      // re: iOS/Android weekday-index risk). It gets refreshed to the following occurrence via
      // `refreshRecurringDeviceCalendarEntries` (deviceCalendarSync.ts) on every app foreground.
      let displayStart = startDate;
      let displayEnd = endDate;
      if (recurrence) {
        const durationMs = endDate.getTime() - startDate.getTime();
        const pseudoEvent = {
          start_time: startDate.toISOString(),
          recurrence,
          timezone: recurrenceTimezone,
        } as unknown as CalendarEvent;
        const next = nextOccurrenceOnOrAfter(pseudoEvent, new Date());
        if (next) {
          displayStart = next;
          displayEnd = new Date(next.getTime() + durationMs);
        }
      }

      const eventDetails = { title: eventTitle, notes: eventDesc, location: eventLoc, startDate: displayStart, endDate: displayEnd, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };

      let resultId: string;
      if (existingEventId) {
        try {
          await ExpoCalendar.updateEventAsync(existingEventId, eventDetails);
          resultId = existingEventId;
        } catch {
          resultId = await ExpoCalendar.createEventAsync(targetCalId, eventDetails);
        }
      } else {
        resultId = await ExpoCalendar.createEventAsync(targetCalId, eventDetails);
      }
      bumpDeviceCalendarSync();
      return resultId;
    } catch (e) {
      console.error('Device calendar write error:', e);
      return null;
    }
  };

  // Schedules (or reschedules) this event's local notification, returning the new
  // notification id (or null if no future reminder was scheduled). Cancels only THIS
  // event's previous notification (by id) rather than
  // `Notifications.cancelAllScheduledNotificationsAsync()` - that used to wipe every other
  // locally scheduled notification on the device, which is fine for one event per note but
  // becomes a real cross-contamination bug once a note carries several independently-edited
  // reminders (editing one used to silently cancel the others too).
  const scheduleReminder = async (eventTitle: string, eventStartTime: Date, minutesBefore: number): Promise<string | null> => {
    if (!Notifications || isWeb) return localNotificationIdRef.current;
    try {
      if (localNotificationIdRef.current) {
        try { await Notifications.cancelScheduledNotificationAsync(localNotificationIdRef.current); } catch {}
      }
      const reminderTime = new Date(eventStartTime.getTime() - minutesBefore * 60 * 1000);
      let newId: string | null = null;
      if (reminderTime > new Date()) {
        newId = await Notifications.scheduleNotificationAsync({
          content: { title: '⏰ Event Reminder', body: `"${eventTitle}" starts in ${getReminderLabel(minutesBefore)}`, sound: true },
          trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: reminderTime },
        });
      }
      localNotificationIdRef.current = newId;
      setLocalNotificationId(newId);
      return newId;
    } catch (e) {
      console.error('Failed to schedule reminder:', e);
      return localNotificationIdRef.current;
    }
  };

  // Cancels this event's previously scheduled local notification (e.g. the user turned the
  // reminder off) without touching any other event's. Same id-tracking as scheduleReminder.
  const cancelLocalNotification = async (): Promise<null> => {
    if (Notifications && !isWeb && localNotificationIdRef.current) {
      try { await Notifications.cancelScheduledNotificationAsync(localNotificationIdRef.current); } catch {}
    }
    localNotificationIdRef.current = null;
    setLocalNotificationId(null);
    return null;
  };

  const getReminderLabel = (minutes: number): string => {
    return REMINDER_OPTIONS.find(o => o.value === minutes)?.label.replace(' before', '') || `${minutes} minutes`;
  };

  // ---- Save logic ----

  // Builds the `Recurrence` payload from state (or `null` for "does not repeat"). Shared by
  // `buildEventData` (what's sent to the server) and `writeToDeviceCalendar`'s callers (which
  // need it separately to compute the next-occurrence display date) so the freq/day/until
  // mapping only lives in one place.
  const getRecurrenceValue = (): Recurrence | null => {
    const freq = recurrenceFreqRef.current;
    if (freq === 'none') return null;
    return {
      freq,
      byweekday: freq === 'weekly' ? recurrenceDaysRef.current : null,
      until: recurrenceUntilRef.current ? toDateString(recurrenceUntilRef.current) : null,
    };
  };

  const buildEventData = (st: Date, et: Date, deviceCalId: string | null) => {
    const recurrence = getRecurrenceValue();
    return {
      title: titleRef.current.trim(),
      description: descriptionRef.current.trim(),
      location: locationRef.current.trim(),
      start_time: st.toISOString(),
      end_time: et.toISOString(),
      linked_note_ids: params.noteId && params.noteId !== 'new' ? [params.noteId] : [],
      reminder_minutes: reminderMinutesRef.current,
      device_calendar_event_id: deviceCalId,
      // `recurrence`/`timezone` are always sent explicitly (including `null` for "does not
      // repeat"), not omitted - the backend's update_event only clears a field on an explicit
      // `null` in the request body, not on an absent key, so omitting it here would fail to
      // clear recurrence when a user turns it off on a previously-recurring event.
      recurrence,
      timezone: recurrence ? Intl.DateTimeFormat().resolvedOptions().timeZone : null,
    };
  };

  const triggerAutoSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setSaveStatus('Unsaved changes');

    saveTimerRef.current = setTimeout(async () => {
      if (!titleRef.current.trim()) { setSaveStatus('Enter a title to save'); return; }

      const st = new Date(dateRef.current);
      st.setHours(startTimeRef.current.getHours(), startTimeRef.current.getMinutes(), 0, 0);
      const et = new Date(endDateRef.current);
      et.setHours(endTimeRef.current.getHours(), endTimeRef.current.getMinutes(), 0, 0);

      if (et <= st) { setSaveStatus('End must be after start'); return; }

      // Check if data actually changed to avoid unnecessary saves
      const recurrenceForHash = getRecurrenceValue();
      const dataHash = `${titleRef.current}|${descriptionRef.current}|${locationRef.current}|${st.toISOString()}|${et.toISOString()}|${reminderMinutesRef.current}|${recurrenceForHash ? `${recurrenceForHash.freq}|${(recurrenceForHash.byweekday || []).join(',')}|${recurrenceForHash.until || ''}` : 'none'}`;
      if (dataHash === lastSavedDataRef.current) return;

      setSaveStatus('Saving...');
      try {
        // Write straight into the device calendar (iOS = Apple Calendar, Android = the Google-synced
        // calendar) natively - no browser redirect. The OS handles syncing to Google/iCloud.
        let newDeviceCalEventId = deviceCalendarEventIdRef.current;
        if (addToDeviceCal && !isWeb) {
          const recurrence = getRecurrenceValue();
          newDeviceCalEventId = await writeToDeviceCalendar(
            titleRef.current.trim(),
            descriptionRef.current.trim(),
            locationRef.current.trim(),
            st, et,
            deviceCalendarEventIdRef.current,
            recurrence,
            recurrence ? Intl.DateTimeFormat().resolvedOptions().timeZone : null,
          );
          if (newDeviceCalEventId) {
            deviceCalendarEventIdRef.current = newDeviceCalEventId;
            setDeviceCalendarEventId(newDeviceCalEventId);
          }
        }

        let newNotificationId = localNotificationIdRef.current;
        if (!isWeb) {
          if (reminderMinutesRef.current) {
            newNotificationId = await scheduleReminder(titleRef.current.trim(), st, reminderMinutesRef.current);
          } else if (localNotificationIdRef.current) {
            newNotificationId = await cancelLocalNotification();
          }
        }

        // Local-first + a durable retry queue (offlineSync.ts) instead of a direct API call -
        // encryption happens inside these, callers pass plaintext.
        const eventData = buildEventData(st, et, newDeviceCalEventId);

        if (!isCreatedRef.current) {
          const created = await createEventOffline(eventData, { push: true });
          eventIdRef.current = created.id;
          isCreatedRef.current = true;
          setEventExists(true);

          if (params.noteId && params.noteId !== 'new') {
            try { await notesApi.update(params.noteId, { linked_event_id: created.id }); } catch {}
          } else {
            try {
              const AsyncStorage = require('@react-native-async-storage/async-storage').default;
              await AsyncStorage.setItem('pendingLinkedEventId', created.id);
            } catch {}
          }
        } else {
          await updateEventOffline(eventIdRef.current, eventData, { push: true });
        }

        // `local_notification_id` is device-local-only (see LocalEvent's comment in
        // offlineSync.ts) - persisted separately from `eventData` above so it's never sent to
        // the server. Done after create/update so `eventIdRef.current` holds the real id (for a
        // brand-new event this is empty until `createEventOffline` resolves above).
        if (eventIdRef.current) {
          try { await setLocalEventNotificationId(eventIdRef.current, newNotificationId); } catch {}
        }

        lastSavedDataRef.current = dataHash;
        setSaveStatus('All changes saved');
      } catch (e: any) {
        setSaveStatus(e?.message?.includes('Network') ? 'Network error - will retry' : 'Failed to save');
        console.error('Save error:', e);
      }
    }, 2000);
  }, [addToDeviceCal, params.noteId]);

  // ---- Back handler ----

  const handleBack = useCallback(async () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);

    // Final save on back
    if (titleRef.current.trim()) {
      const st = new Date(dateRef.current);
      st.setHours(startTimeRef.current.getHours(), startTimeRef.current.getMinutes(), 0, 0);
      const et = new Date(endDateRef.current);
      et.setHours(endTimeRef.current.getHours(), endTimeRef.current.getMinutes(), 0, 0);

      if (et > st) {
        try {
          // Write to the device calendar natively (both platforms) before persisting, so a quick
          // back-out still lands the event on the calendar. Idempotent via the stored event id.
          let devId = deviceCalendarEventIdRef.current;
          if (addToDeviceCal && !isWeb) {
            const recurrence = getRecurrenceValue();
            const written = await writeToDeviceCalendar(
              titleRef.current.trim(), descriptionRef.current.trim(), locationRef.current.trim(), st, et, devId,
              recurrence,
              recurrence ? Intl.DateTimeFormat().resolvedOptions().timeZone : null,
            );
            if (written) { devId = written; deviceCalendarEventIdRef.current = written; }
          }
          const eventData = buildEventData(st, et, devId);
          if (!isCreatedRef.current) {
            const created = await createEventOffline(eventData, { push: true });
            if (params.noteId && params.noteId !== 'new') {
              await notesApi.update(params.noteId, { linked_event_id: created.id });
            } else if (params.noteId === 'new') {
              const AsyncStorage = require('@react-native-async-storage/async-storage').default;
              await AsyncStorage.setItem('pendingLinkedEventId', created.id);
            }
          } else {
            await updateEventOffline(eventIdRef.current, eventData, { push: true });
          }
        } catch (e) {
          console.error('Final save on back failed:', e);
        }
      }
    }

    if (params.noteId) {
      router.back();
    } else {
      router.replace('/(tabs)/events');
    }
  }, [params.noteId, router, addToDeviceCal]);

  // ---- Delete ----

  const handleDeletePress = () => { if (!eventIdRef.current) return; setDeleteModalVisible(true); };

  const confirmDelete = async () => {
    const idToDelete = params.eventId || eventIdRef.current;
    if (!idToDelete) return;
    setDeleting(true);
    try {
      if (ExpoCalendar && deviceCalendarEventIdRef.current && !isWeb) {
        try { await ExpoCalendar.deleteEventAsync(deviceCalendarEventIdRef.current); bumpDeviceCalendarSync(); } catch {}
      }
      // Deleting the event should also cancel its own scheduled local notification - otherwise
      // it fires later pointing at an event that no longer exists.
      if (Notifications && localNotificationIdRef.current && !isWeb) {
        try { await Notifications.cancelScheduledNotificationAsync(localNotificationIdRef.current); } catch {}
      }
      await deleteEventOffline(idToDelete, { push: true });
      setDeleteModalVisible(false);
      router.back();
    } catch (e) {
      console.error('Delete failed:', e);
      setDeleting(false);
    }
  };

  // ---- Auto-save trigger ----

  useEffect(() => {
    if (title || description) triggerAutoSave();
  }, [title, description, location, date, endDate, startTime, endTime, reminderMinutes, recurrenceFreq, recurrenceDays, recurrenceUntil, triggerAutoSave]);

  const filteredImportEvents = importSearch.trim()
    ? importEvents.filter((e) => e.title.toLowerCase().includes(importSearch.trim().toLowerCase()))
    : importEvents;

  // ---- Render ----

  if (loading) {
    return (
      <SafeAreaView style={s.container}>
        <View style={s.center}><ActivityIndicator size="large" color={C.primary} /></View>
      </SafeAreaView>
    );
  }

  const isIOS = Platform.OS === 'ios';
  const isAndroid = Platform.OS === 'android';
  const selectedCalendarLabel = preferredCalendarId
    ? (calendars.find(c => c.id === preferredCalendarId)?.title || 'Selected calendar')
    : 'Default calendar';

  return (
    <SafeAreaView style={s.container}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>

        {/* Header */}
        <View style={s.header}>
          <TouchableOpacity testID="event-back-btn" style={s.headerBtn} onPress={handleBack}>
            <MaterialIcons name="arrow-back" size={28} color={C.text} />
            <Text style={s.headerBtnLabel}>Back</Text>
          </TouchableOpacity>
          <Text style={s.headerTitle}>{isEditing ? 'Edit Event' : 'New Event'}</Text>
          <View style={{ width: 80 }} />
        </View>

        {/* Save Status */}
        {saveStatus ? (
          <View style={s.statusBar}>
            <MaterialIcons
              name={saveStatus === 'All changes saved' ? 'check-circle' : saveStatus === 'Saving...' ? 'sync' : 'error'}
              size={16}
              color={saveStatus === 'All changes saved' ? C.success : saveStatus.includes('error') || saveStatus.includes('Failed') ? C.error : C.textSec}
            />
            <Text style={[s.statusText, {
              color: saveStatus === 'All changes saved' ? C.success : saveStatus.includes('error') || saveStatus.includes('Failed') ? C.error : C.textSec,
            }]}>{saveStatus}</Text>
          </View>
        ) : null}

        <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent} keyboardShouldPersistTaps="handled">

          {/* Import from device calendar (new events only) */}
          {!isEditing && !isWeb && (
            <TouchableOpacity testID="import-event-btn" style={s.importBtn} onPress={openImportPicker}>
              <MaterialIcons name="event-available" size={24} color={C.secondary} />
              <Text style={s.importBtnText}>Import from {isIOS ? 'Apple' : 'Google'} Calendar</Text>
              <MaterialIcons name="chevron-right" size={24} color={C.borderSub} />
            </TouchableOpacity>
          )}

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

          {/* Start Date */}
          <Text style={s.label}>Start Date</Text>
          {isWeb && <NativeDateInput testID="native-date-input" value={date} onChange={handleStartDateChange} />}
          {isIOS && DateTimePicker && (
            <>
              <TouchableOpacity testID="ios-date-btn" style={s.pickerBtn} onPress={() => setShowDatePicker(true)}>
                <MaterialIcons name="calendar-today" size={24} color={C.secondary} />
                <Text style={s.pickerBtnText}>{formatDisplayDate(date)}</Text>
                <MaterialIcons name="arrow-drop-down" size={28} color={C.borderSub} />
              </TouchableOpacity>
              {showDatePicker && (
                <Modal transparent animationType="slide">
                  <View style={s.pickerModalOverlay}>
                    <View style={s.pickerModalContent}>
                      <View style={s.pickerModalHeader}>
                        <Text style={s.pickerModalTitle}>Select Start Date</Text>
                        <TouchableOpacity onPress={() => setShowDatePicker(false)}>
                          <Text style={s.pickerModalDone}>Done</Text>
                        </TouchableOpacity>
                      </View>
                      <DateTimePicker testID="ios-date-picker" value={date} mode="date" display="spinner" onChange={(_e: any, d?: Date) => d && handleStartDateChange(d)} style={{ height: 200 }} textColor={C.text} />
                    </View>
                  </View>
                </Modal>
              )}
            </>
          )}
          {isAndroid && (
            <>
              <TouchableOpacity testID="android-date-btn" style={s.pickerBtn} onPress={() => setShowDatePicker(true)}>
                <MaterialIcons name="calendar-today" size={24} color={C.secondary} />
                <Text style={s.pickerBtnText}>{formatDisplayDate(date)}</Text>
                <MaterialIcons name="arrow-drop-down" size={28} color={C.borderSub} />
              </TouchableOpacity>
              {showDatePicker && DateTimePicker && (
                <DateTimePicker testID="android-date-picker" value={date} mode="date" display="default" onChange={(_e: any, d?: Date) => { setShowDatePicker(false); if (d) handleStartDateChange(d); }} />
              )}
            </>
          )}

          {/* End Date */}
          <Text style={s.label}>End Date</Text>
          {isWeb && (
            <NativeDateInput
              testID="native-end-date-input"
              value={endDate}
              onChange={(d) => setEndDate(d)}
            />
          )}
          {isIOS && DateTimePicker && (
            <>
              <TouchableOpacity testID="ios-end-date-btn" style={s.pickerBtn} onPress={() => setShowEndDatePicker(true)}>
                <MaterialIcons name="event" size={24} color={C.secondary} />
                <Text style={s.pickerBtnText}>{formatDisplayDate(endDate)}</Text>
                <MaterialIcons name="arrow-drop-down" size={28} color={C.borderSub} />
              </TouchableOpacity>
              {showEndDatePicker && (
                <Modal transparent animationType="slide">
                  <View style={s.pickerModalOverlay}>
                    <View style={s.pickerModalContent}>
                      <View style={s.pickerModalHeader}>
                        <Text style={s.pickerModalTitle}>Select End Date</Text>
                        <TouchableOpacity onPress={() => setShowEndDatePicker(false)}>
                          <Text style={s.pickerModalDone}>Done</Text>
                        </TouchableOpacity>
                      </View>
                      <DateTimePicker testID="ios-end-date-picker" value={endDate} mode="date" display="spinner" onChange={(_e: any, d?: Date) => d && setEndDate(d)} style={{ height: 200 }} textColor={C.text} />
                    </View>
                  </View>
                </Modal>
              )}
            </>
          )}
          {isAndroid && (
            <>
              <TouchableOpacity testID="android-end-date-btn" style={s.pickerBtn} onPress={() => setShowEndDatePicker(true)}>
                <MaterialIcons name="event" size={24} color={C.secondary} />
                <Text style={s.pickerBtnText}>{formatDisplayDate(endDate)}</Text>
                <MaterialIcons name="arrow-drop-down" size={28} color={C.borderSub} />
              </TouchableOpacity>
              {showEndDatePicker && DateTimePicker && (
                <DateTimePicker testID="android-end-date-picker" value={endDate} mode="date" display="default" onChange={(_e: any, d?: Date) => { setShowEndDatePicker(false); if (d) setEndDate(d); }} />
              )}
            </>
          )}

          {/* Start Time */}
          <Text style={s.label}>Start Time</Text>
          {isWeb && <NativeTimeInput testID="native-start-time" value={startTime} onChange={(d) => { setStartTime(d); setEndTime(addOneHour(d)); }} />}
          {isIOS && DateTimePicker && (
            <>
              <TouchableOpacity testID="ios-start-btn" style={s.pickerBtn} onPress={() => setShowStartPicker(true)}>
                <MaterialIcons name="access-time" size={24} color={C.secondary} />
                <Text style={s.pickerBtnText}>{formatDisplayTime(startTime)}</Text>
                <MaterialIcons name="arrow-drop-down" size={28} color={C.borderSub} />
              </TouchableOpacity>
              {showStartPicker && (
                <Modal transparent animationType="slide">
                  <View style={s.pickerModalOverlay}>
                    <View style={s.pickerModalContent}>
                      <View style={s.pickerModalHeader}>
                        <Text style={s.pickerModalTitle}>Select Start Time</Text>
                        <TouchableOpacity onPress={() => setShowStartPicker(false)}>
                          <Text style={s.pickerModalDone}>Done</Text>
                        </TouchableOpacity>
                      </View>
                      <DateTimePicker
                        testID="ios-start-picker"
                        value={startTime}
                        mode="time"
                        display="spinner"
                        onChange={(_e: any, d?: Date) => { if (d) { setStartTime(d); setEndTime(addOneHour(d)); } }}
                        minuteInterval={5}
                        style={{ height: 200 }}
                        textColor={C.text}
                      />
                    </View>
                  </View>
                </Modal>
              )}
            </>
          )}
          {isAndroid && (
            <>
              <TouchableOpacity testID="android-start-btn" style={s.pickerBtn} onPress={() => setShowStartPicker(true)}>
                <MaterialIcons name="access-time" size={24} color={C.secondary} />
                <Text style={s.pickerBtnText}>{formatDisplayTime(startTime)}</Text>
                <MaterialIcons name="arrow-drop-down" size={28} color={C.borderSub} />
              </TouchableOpacity>
              {showStartPicker && DateTimePicker && (
                <DateTimePicker
                  testID="android-start-picker"
                  value={startTime}
                  mode="time"
                  display="default"
                  minuteInterval={5}
                  onChange={(_e: any, d?: Date) => { setShowStartPicker(false); if (d) { setStartTime(d); setEndTime(addOneHour(d)); } }}
                />
              )}
            </>
          )}

          {/* End Time */}
          <Text style={s.label}>End Time</Text>
          {isWeb && <NativeTimeInput testID="native-end-time" value={endTime} onChange={setEndTime} />}
          {isIOS && DateTimePicker && (
            <>
              <TouchableOpacity testID="ios-end-btn" style={s.pickerBtn} onPress={() => setShowEndPicker(true)}>
                <MaterialIcons name="access-time" size={24} color={C.secondary} />
                <Text style={s.pickerBtnText}>{formatDisplayTime(endTime)}</Text>
                <MaterialIcons name="arrow-drop-down" size={28} color={C.borderSub} />
              </TouchableOpacity>
              {showEndPicker && (
                <Modal transparent animationType="slide">
                  <View style={s.pickerModalOverlay}>
                    <View style={s.pickerModalContent}>
                      <View style={s.pickerModalHeader}>
                        <Text style={s.pickerModalTitle}>Select End Time</Text>
                        <TouchableOpacity onPress={() => setShowEndPicker(false)}>
                          <Text style={s.pickerModalDone}>Done</Text>
                        </TouchableOpacity>
                      </View>
                      <DateTimePicker testID="ios-end-picker" value={endTime} mode="time" display="spinner" onChange={(_e: any, d?: Date) => d && setEndTime(d)} minuteInterval={5} style={{ height: 200 }} textColor={C.text} />
                    </View>
                  </View>
                </Modal>
              )}
            </>
          )}
          {isAndroid && (
            <>
              <TouchableOpacity testID="android-end-btn" style={s.pickerBtn} onPress={() => setShowEndPicker(true)}>
                <MaterialIcons name="access-time" size={24} color={C.secondary} />
                <Text style={s.pickerBtnText}>{formatDisplayTime(endTime)}</Text>
                <MaterialIcons name="arrow-drop-down" size={28} color={C.borderSub} />
              </TouchableOpacity>
              {showEndPicker && DateTimePicker && (
                <DateTimePicker testID="android-end-picker" value={endTime} mode="time" display="default" minuteInterval={5} onChange={(_e: any, d?: Date) => { setShowEndPicker(false); if (d) setEndTime(d); }} />
              )}
            </>
          )}

          {/* Location */}
          <Text style={s.label}>Location</Text>
          <View style={s.pickerBtn}>
            <MaterialIcons name="place" size={24} color={C.secondary} />
            <TextInput
              testID="event-location-input"
              style={s.locationInput}
              placeholder="Add a location..."
              placeholderTextColor={C.borderSub}
              value={location}
              onChangeText={setLocation}
            />
            {!isWeb && (
              <TouchableOpacity
                testID="use-current-location-btn"
                onPress={useCurrentLocation}
                disabled={fetchingLocation}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                {fetchingLocation ? (
                  <ActivityIndicator size="small" color={C.secondary} />
                ) : (
                  <MaterialIcons name="my-location" size={22} color={C.secondary} />
                )}
              </TouchableOpacity>
            )}
          </View>

          {/* Description */}
          <Text style={s.label}>Description</Text>
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

          {/* Calendar Toggle */}
          {!isWeb && (
            <View style={s.calendarToggle}>
              <View style={s.calendarToggleLeft}>
                <MaterialIcons name={isIOS ? 'event' : 'event-available'} size={28} color={C.secondary} />
                <View style={s.calendarToggleTextContainer}>
                  <Text style={s.calendarToggleTitle}>{isIOS ? 'Sync to Apple Calendar' : 'Sync to Google Calendar'}</Text>
                  <Text style={s.calendarToggleSubtitle}>{isIOS ? 'Syncs directly to your Apple Calendar' : 'Syncs directly to your Google Calendar'}</Text>
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

          {/* Calendar picker - which device calendar to write to (shown when sync is on) */}
          {!isWeb && addToDeviceCal && (
            <TouchableOpacity
              testID="calendar-picker-btn"
              style={[s.pickerBtn, { marginTop: 12 }]}
              onPress={async () => { await loadCalendars({ prompt: true }); setShowCalendarPicker(true); }}
            >
              <MaterialIcons name="event" size={24} color={C.secondary} />
              <Text style={s.pickerBtnText} numberOfLines={1}>{selectedCalendarLabel}</Text>
              <MaterialIcons name="arrow-drop-down" size={28} color={C.borderSub} />
            </TouchableOpacity>
          )}

          {/* Reminder */}
          <Text style={s.label}>Reminder</Text>
          <TouchableOpacity testID="reminder-picker-btn" style={s.pickerBtn} onPress={() => setShowReminderPicker(true)}>
            <MaterialIcons name="notifications" size={24} color={C.secondary} />
            <Text style={s.pickerBtnText}>{REMINDER_OPTIONS.find(o => o.value === reminderMinutes)?.label || 'No Reminder'}</Text>
            <MaterialIcons name="arrow-drop-down" size={28} color={C.borderSub} />
          </TouchableOpacity>

          <Modal testID="reminder-modal" visible={showReminderPicker} transparent animationType="fade" onRequestClose={() => setShowReminderPicker(false)}>
            <TouchableOpacity style={s.modalOverlay} activeOpacity={1} onPress={() => setShowReminderPicker(false)}>
              <View style={s.reminderModal}>
                <Text style={s.reminderModalTitle}>Set Reminder</Text>
                {REMINDER_OPTIONS.map((option) => (
                  <TouchableOpacity
                    key={option.label}
                    style={[s.reminderOption, reminderMinutes === option.value && s.reminderOptionSelected]}
                    onPress={() => { setReminderMinutes(option.value); setShowReminderPicker(false); }}
                  >
                    <MaterialIcons name={option.value === null ? 'notifications-off' : 'notifications'} size={22} color={reminderMinutes === option.value ? C.primaryFg : C.textSec} />
                    <Text style={[s.reminderOptionText, reminderMinutes === option.value && s.reminderOptionTextSelected]}>{option.label}</Text>
                    {reminderMinutes === option.value && <MaterialIcons name="check" size={22} color={C.primaryFg} />}
                  </TouchableOpacity>
                ))}
              </View>
            </TouchableOpacity>
          </Modal>

          {/* Repeat */}
          <Text style={s.label}>Repeat</Text>
          <TouchableOpacity testID="recurrence-picker-btn" style={s.pickerBtn} onPress={() => setShowRecurrencePicker(true)}>
            <MaterialIcons name="event-repeat" size={24} color={C.secondary} />
            <Text style={s.pickerBtnText}>{RECURRENCE_OPTIONS.find(o => o.value === recurrenceFreq)?.label || 'Does not repeat'}</Text>
            <MaterialIcons name="arrow-drop-down" size={28} color={C.borderSub} />
          </TouchableOpacity>

          {recurrenceFreq === 'weekly' && (
            <View style={s.dayChipsRow}>
              {DAY_NAMES.map((label, idx) => {
                const selected = recurrenceDays.includes(idx);
                return (
                  <TouchableOpacity
                    key={label}
                    testID={`recurrence-day-${idx}`}
                    style={[s.dayChip, selected && s.dayChipSelected]}
                    onPress={() => setRecurrenceDays((prev) =>
                      prev.includes(idx) ? prev.filter((d) => d !== idx) : [...prev, idx].sort((a, b) => a - b)
                    )}
                  >
                    <Text style={[s.dayChipText, selected && s.dayChipTextSelected]}>{label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          {recurrenceFreq !== 'none' && (
            <>
              <Text style={s.label}>Ends</Text>
              <View style={s.endsRow}>
                <View style={{ flex: 1 }}>
                  {isWeb && (
                    <NativeDateInput
                      testID="recurrence-until-input"
                      value={recurrenceUntil || new Date()}
                      onChange={(d) => setRecurrenceUntil(d)}
                    />
                  )}
                  {!isWeb && (
                    <TouchableOpacity testID="recurrence-until-btn" style={s.pickerBtn} onPress={() => setShowRecurrenceUntilPicker(true)}>
                      <MaterialIcons name="event-busy" size={24} color={C.secondary} />
                      <Text style={s.pickerBtnText}>{recurrenceUntil ? formatDisplayDate(recurrenceUntil) : 'No end date'}</Text>
                      <MaterialIcons name="arrow-drop-down" size={28} color={C.borderSub} />
                    </TouchableOpacity>
                  )}
                </View>
                {recurrenceUntil && (
                  <TouchableOpacity
                    testID="recurrence-until-clear-btn"
                    style={s.endsClearBtn}
                    onPress={() => setRecurrenceUntil(null)}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  >
                    <MaterialIcons name="close" size={22} color={C.textSec} />
                  </TouchableOpacity>
                )}
              </View>
              {isIOS && DateTimePicker && showRecurrenceUntilPicker && (
                <Modal transparent animationType="slide">
                  <View style={s.pickerModalOverlay}>
                    <View style={s.pickerModalContent}>
                      <View style={s.pickerModalHeader}>
                        <Text style={s.pickerModalTitle}>Select End Date</Text>
                        <TouchableOpacity onPress={() => setShowRecurrenceUntilPicker(false)}>
                          <Text style={s.pickerModalDone}>Done</Text>
                        </TouchableOpacity>
                      </View>
                      <DateTimePicker
                        testID="recurrence-until-picker"
                        value={recurrenceUntil || new Date()}
                        mode="date"
                        display="spinner"
                        onChange={(_e: any, d?: Date) => d && setRecurrenceUntil(d)}
                        style={{ height: 200 }}
                        textColor={C.text}
                      />
                    </View>
                  </View>
                </Modal>
              )}
              {isAndroid && DateTimePicker && showRecurrenceUntilPicker && (
                <DateTimePicker
                  testID="recurrence-until-picker-android"
                  value={recurrenceUntil || new Date()}
                  mode="date"
                  display="default"
                  onChange={(_e: any, d?: Date) => { setShowRecurrenceUntilPicker(false); if (d) setRecurrenceUntil(d); }}
                />
              )}
            </>
          )}

          <Modal testID="recurrence-modal" visible={showRecurrencePicker} transparent animationType="fade" onRequestClose={() => setShowRecurrencePicker(false)}>
            <TouchableOpacity style={s.modalOverlay} activeOpacity={1} onPress={() => setShowRecurrencePicker(false)}>
              <View style={s.reminderModal}>
                <Text style={s.reminderModalTitle}>Repeat</Text>
                {RECURRENCE_OPTIONS.map((option) => (
                  <TouchableOpacity
                    key={option.value}
                    style={[s.reminderOption, recurrenceFreq === option.value && s.reminderOptionSelected]}
                    onPress={() => {
                      setRecurrenceFreq(option.value);
                      // Nicer default than an empty day-chip row: preselect the event's own
                      // start-date weekday, matching the fallback `recurrence.ts`/the backend
                      // already apply for an empty `byweekday` (repeats on start_time's weekday).
                      if (option.value === 'weekly' && recurrenceDaysRef.current.length === 0) {
                        setRecurrenceDays([dateRef.current.getDay()]);
                      }
                      setShowRecurrencePicker(false);
                    }}
                  >
                    <MaterialIcons name={option.value === 'none' ? 'event-busy' : 'event-repeat'} size={22} color={recurrenceFreq === option.value ? C.primaryFg : C.textSec} />
                    <Text style={[s.reminderOptionText, recurrenceFreq === option.value && s.reminderOptionTextSelected]}>{option.label}</Text>
                    {recurrenceFreq === option.value && <MaterialIcons name="check" size={22} color={C.primaryFg} />}
                  </TouchableOpacity>
                ))}
              </View>
            </TouchableOpacity>
          </Modal>

          {/* Calendar Picker Modal */}
          <Modal testID="calendar-modal" visible={showCalendarPicker} transparent animationType="fade" onRequestClose={() => setShowCalendarPicker(false)}>
            <TouchableOpacity style={s.modalOverlay} activeOpacity={1} onPress={() => setShowCalendarPicker(false)}>
              <View style={s.reminderModal}>
                <Text style={s.reminderModalTitle}>Choose Calendar</Text>
                <TouchableOpacity style={[s.reminderOption, !preferredCalendarId && s.reminderOptionSelected]} onPress={() => selectCalendar(null)}>
                  <MaterialIcons name="event" size={22} color={!preferredCalendarId ? C.primaryFg : C.textSec} />
                  <Text style={[s.reminderOptionText, !preferredCalendarId && s.reminderOptionTextSelected]}>Default calendar</Text>
                  {!preferredCalendarId && <MaterialIcons name="check" size={22} color={C.primaryFg} />}
                </TouchableOpacity>
                {calendars.map((cal) => (
                  <TouchableOpacity
                    key={cal.id}
                    style={[s.reminderOption, preferredCalendarId === cal.id && s.reminderOptionSelected]}
                    onPress={() => selectCalendar(cal.id)}
                  >
                    <MaterialIcons name="event-available" size={22} color={preferredCalendarId === cal.id ? C.primaryFg : C.textSec} />
                    <Text style={[s.reminderOptionText, preferredCalendarId === cal.id && s.reminderOptionTextSelected]} numberOfLines={1}>
                      {cal.title}{cal.source ? ` · ${cal.source}` : ''}{!cal.isSynced ? ' (this device only)' : ''}
                    </Text>
                    {preferredCalendarId === cal.id && <MaterialIcons name="check" size={22} color={C.primaryFg} />}
                  </TouchableOpacity>
                ))}
              </View>
            </TouchableOpacity>
          </Modal>

          {/* Import from Device Calendar Modal */}
          <Modal
            testID="import-picker-modal"
            visible={showImportPicker}
            transparent
            animationType="slide"
            onRequestClose={() => setShowImportPicker(false)}
          >
            <View style={s.pickerModalOverlay}>
              <View style={[s.pickerModalContent, s.importModalContent]}>
                <View style={s.pickerModalHeader}>
                  <Text style={s.pickerModalTitle}>Import from Calendar</Text>
                  <TouchableOpacity onPress={() => setShowImportPicker(false)}>
                    <Text style={s.pickerModalDone}>Close</Text>
                  </TouchableOpacity>
                </View>
                <TextInput
                  testID="import-search-input"
                  style={s.importSearchInput}
                  placeholder="Search events..."
                  placeholderTextColor={C.borderSub}
                  value={importSearch}
                  onChangeText={setImportSearch}
                />
                {importLoading ? (
                  <View style={[s.center, { height: 200 }]}>
                    <ActivityIndicator size="large" color={C.primary} />
                  </View>
                ) : filteredImportEvents.length === 0 ? (
                  <View style={[s.center, { height: 200 }]}>
                    <Text style={s.importEmptyText}>No upcoming events found</Text>
                  </View>
                ) : (
                  <ScrollView style={s.importList}>
                    {filteredImportEvents.map((ev) => (
                      <TouchableOpacity
                        key={ev.id}
                        testID={`import-event-row-${ev.id}`}
                        style={s.importRow}
                        onPress={() => selectImportEvent(ev)}
                      >
                        <Text style={s.importRowTitle} numberOfLines={1}>{ev.title}</Text>
                        <Text style={s.importRowSubtitle} numberOfLines={1}>
                          {ev.allDay ? 'All day · ' : ''}{formatDisplayDate(new Date(ev.startDate))} · {formatDisplayTime(new Date(ev.startDate))}
                          {ev.calendarTitle ? ` · ${ev.calendarTitle}` : ''}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                )}
              </View>
            </View>
          </Modal>

          {/* Linked Note */}
          {params.noteId && params.noteId !== 'new' && (
            <View style={s.linkedNote}>
              <MaterialIcons name="link" size={20} color={C.secondary} />
              <Text style={s.linkedNoteText}>Will be linked to note: {params.noteTitle || 'Untitled'}</Text>
            </View>
          )}

          {/* Delete Button */}
          {eventExists && (
            <Button
              testID="delete-event-btn"
              variant="box"
              layout="row"
              tone="danger"
              icon="delete"
              label="Delete Event"
              onPress={handleDeletePress}
              style={s.deleteBtn}
            />
          )}

          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Delete Modal */}
      <Modal visible={deleteModalVisible} transparent animationType="fade" onRequestClose={() => setDeleteModalVisible(false)}>
        <View style={s.modalOverlay}>
          <View style={s.modalContent}>
            <MaterialIcons name="delete" size={48} color={C.error} style={{ marginBottom: 16 }} />
            <Text style={s.modalTitle}>Delete Event?</Text>
            <Text style={s.modalMessage}>Are you sure you want to delete "{title || 'this event'}"? This action cannot be undone.</Text>
            <View style={s.modalButtons}>
              <TouchableOpacity style={s.modalCancelBtn} onPress={() => setDeleteModalVisible(false)} activeOpacity={0.7}>
                <Text style={s.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.modalDeleteBtn} onPress={confirmDelete} activeOpacity={0.7} disabled={deleting}>
                {deleting ? <ActivityIndicator size="small" color="#FFFFFF" /> : <Text style={s.modalDeleteText}>Delete</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Success Overlay */}
      <Modal visible={showSuccessOverlay} transparent animationType="fade">
        <View style={s.successOverlay}>
          <View style={s.successContent}>
            <MaterialIcons name="check-circle" size={64} color="#4CAF50" />
            <Text style={s.successText}>{isEditing ? 'Event Updated!' : 'Event Created!'}</Text>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.borderSub + '40' },
  headerBtn: { flexDirection: 'row', alignItems: 'center', height: 48 },
  headerBtnLabel: { fontSize: 18, fontWeight: '600', color: C.text, marginLeft: 4 },
  headerTitle: { fontSize: 22, fontWeight: '700', color: C.text },
  statusBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 8, paddingHorizontal: 16, backgroundColor: C.bg, borderBottomWidth: 1, borderBottomColor: C.borderSub },
  statusText: { fontSize: 14, marginLeft: 6 },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 24, paddingTop: 24 },
  label: { fontSize: 18, fontWeight: '600', color: C.textSec, marginBottom: 8, marginTop: 20 },
  input: { height: 56, borderWidth: 1, borderColor: C.border, borderRadius: 12, paddingHorizontal: 16, fontSize: 20, color: C.text, backgroundColor: C.surface },
  pickerContainer: { backgroundColor: C.surface, borderRadius: 12, borderWidth: 1, borderColor: C.border, overflow: 'hidden' },
  pickerBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.surface, borderRadius: 12, borderWidth: 1, borderColor: C.border, paddingHorizontal: 16, height: 60 },
  pickerBtnText: { flex: 1, fontSize: 20, fontWeight: '400', color: C.text, marginLeft: 12 },
  locationInput: { flex: 1, fontSize: 20, fontWeight: '400', color: C.text, marginLeft: 12, height: '100%' },
  descInput: { minHeight: 100, borderWidth: 1, borderColor: C.border, borderRadius: 12, paddingHorizontal: 16, paddingTop: 12, fontSize: 20, color: C.text, backgroundColor: C.surface, textAlignVertical: 'top' },
  linkedNote: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.secondary + '15', borderRadius: 8, padding: 12, marginTop: 16 },
  linkedNoteText: { fontSize: 16, color: C.secondary, marginLeft: 8, flex: 1 },
  saveBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: C.primary, borderRadius: 16, height: 64, marginTop: 24 },
  saveBtnText: { fontSize: 20, fontWeight: '600', color: C.primaryFg, marginLeft: 8 },
  deleteBtn: { height: 64, marginTop: 12 },
  calendarToggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: C.surface, borderRadius: 16, borderWidth: 2, borderColor: C.secondary + '40', padding: 16, marginTop: 24 },
  calendarToggleLeft: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  calendarToggleTextContainer: { marginLeft: 12, flex: 1 },
  calendarToggleTitle: { fontSize: 18, fontWeight: '600', color: C.text },
  calendarToggleSubtitle: { fontSize: 14, color: C.textSec, marginTop: 2 },
  importBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.surface, borderRadius: radius.lg, borderWidth: borderWidth.thick, borderColor: C.secondary + '40', paddingHorizontal: 16, height: 60, marginBottom: 20 },
  importBtnText: { flex: 1, fontSize: 18, fontWeight: '600', color: C.secondary, marginLeft: 12 },
  importModalContent: { maxHeight: '75%' },
  importSearchInput: { height: 52, borderWidth: 2, borderColor: C.borderSub, borderRadius: 12, paddingHorizontal: 16, fontSize: 17, color: C.text, backgroundColor: C.bg, marginHorizontal: 20, marginTop: 12 },
  importList: { marginTop: 8, paddingHorizontal: 20 },
  importRow: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: C.borderSub + '30' },
  importRowTitle: { fontSize: 18, fontWeight: '600', color: C.text },
  importRowSubtitle: { fontSize: 14, color: C.textSec, marginTop: 4 },
  importEmptyText: { fontSize: 16, color: C.textSec },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.5)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  modalContent: { backgroundColor: C.surface, borderRadius: 20, padding: 24, width: '100%', maxWidth: 340, alignItems: 'center' },
  modalTitle: { fontSize: 22, fontWeight: '700', color: C.text, marginBottom: 12 },
  modalMessage: { fontSize: 16, color: C.textSec, textAlign: 'center', lineHeight: 24, marginBottom: 24 },
  modalButtons: { flexDirection: 'row', gap: 12, width: '100%' },
  modalCancelBtn: { flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: '#E0E0E0', alignItems: 'center' },
  modalCancelText: { fontSize: 16, fontWeight: '600', color: C.text },
  modalDeleteBtn: { flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: C.error, alignItems: 'center' },
  modalDeleteText: { fontSize: 16, fontWeight: '600', color: '#FFFFFF' },
  reminderModal: { backgroundColor: C.surface, borderRadius: 20, padding: 20, width: '100%', maxWidth: 340 },
  reminderModalTitle: { fontSize: 20, fontWeight: '600', color: C.text, textAlign: 'center', marginBottom: 16 },
  reminderOption: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 16, borderRadius: 12, marginBottom: 8, backgroundColor: C.bg },
  reminderOptionSelected: { backgroundColor: C.primary },
  reminderOptionText: { flex: 1, fontSize: 16, color: C.text, marginLeft: 12, fontWeight: '400' },
  reminderOptionTextSelected: { color: C.primaryFg, fontWeight: '400' },
  dayChipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  dayChip: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: radius.pill, borderWidth: borderWidth.regular, borderColor: C.border, backgroundColor: C.surface },
  dayChipSelected: { backgroundColor: C.primary, borderColor: C.primary },
  dayChipText: { fontSize: 15, fontWeight: '600', color: C.textSec },
  dayChipTextSelected: { color: C.primaryFg },
  endsRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  endsClearBtn: { padding: 8 },
  pickerModalOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0, 0, 0, 0.3)' },
  pickerModalContent: { backgroundColor: C.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 30 },
  pickerModalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: C.borderSub + '40' },
  pickerModalTitle: { fontSize: 18, fontWeight: '600', color: C.text },
  pickerModalDone: { fontSize: 18, fontWeight: '600', color: C.secondary },
  successOverlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0, 0, 0, 0.5)' },
  successContent: { backgroundColor: C.surface, borderRadius: 20, padding: 32, alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 8 },
  successText: { fontSize: 20, fontWeight: '600', color: C.text, marginTop: 16 },
});