/**
 * Push-notification registration + handlers for event reminders (Phase 2).
 *
 * The backend fires reminders as Expo push messages (see server.py /internal/push/tick). Here we:
 *  - register this device's Expo push token with the backend (on login),
 *  - unregister it on logout,
 *  - present reminders while the app is foregrounded,
 *  - deep-link into the event when a reminder is tapped.
 *
 * All best-effort: push may be unavailable (web, no permission, FCM/APNs not configured) - nothing
 * here throws into the app.
 */
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { pushApi } from './api';
import { getLocalEvents, setLocalEventNotificationId } from './offlineSync';
import { nextOccurrenceOnOrAfter } from './recurrence';
import type { CalendarEvent } from './types';

let Notifications: typeof import('expo-notifications') | null = null;
if (Platform.OS !== 'web') {
  try { Notifications = require('expo-notifications'); } catch {}
}

const STORED_TOKEN_KEY = 'expo_push_token';
export const EVENT_REMINDER_CHANNEL = 'event-reminders';

/** Show reminders as a banner (with sound) while the app is open. */
export function setupNotificationHandler(): void {
  if (!Notifications) return;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

/**
 * Request permission, create the Android channel, get the Expo push token, and register it with the
 * backend. Safe to call repeatedly (register is an idempotent upsert). Never throws.
 */
export async function registerForPushNotifications(): Promise<void> {
  if (!Notifications || Platform.OS === 'web') return;
  try {
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') {
      status = (await Notifications.requestPermissionsAsync()).status;
    }
    if (status !== 'granted') return;

    if (Platform.OS === 'android') {
      // Omit `sound` entirely to get the system default notification sound - passing the
      // string 'default' makes expo-notifications look for a bundled raw resource literally
      // named "default", which doesn't exist, and logs a "Custom sound not found" error.
      await Notifications.setNotificationChannelAsync(EVENT_REMINDER_CHANNEL, {
        name: 'Event reminders',
        importance: Notifications.AndroidImportance.HIGH,
      });
    }

    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ?? (Constants as any)?.easConfig?.projectId;
    const { data: token } = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    if (!token) return;

    await pushApi.register(token, Platform.OS);
    await AsyncStorage.setItem(STORED_TOKEN_KEY, token);
  } catch (e) {
    console.warn('Push registration failed:', e);
  }
}

/** Mark this device's token inactive server-side (on logout). Never throws. */
export async function unregisterPushNotifications(): Promise<void> {
  try {
    const token = await AsyncStorage.getItem(STORED_TOKEN_KEY);
    if (token) {
      await pushApi.unregister(token, Platform.OS);
      await AsyncStorage.removeItem(STORED_TOKEN_KEY);
    }
  } catch (e) {
    console.warn('Push unregistration failed:', e);
  }
}

function reminderLabel(minutes: number): string {
  if (minutes === 5) return '5 minutes';
  if (minutes === 15) return '15 minutes';
  if (minutes === 30) return '30 minutes';
  if (minutes === 60) return '1 hour';
  if (minutes === 1440) return '1 day';
  return `${minutes} minutes`;
}

/**
 * Keeps a recurring event's local reminder aimed at its CURRENT next occurrence. scheduleReminder
 * (event-editor.tsx) only runs on create/edit, and expo-notifications' DATE trigger fires once -
 * without this, opening an old recurring event to make any edit would compute a reminder time
 * from its original (possibly long-past) start_time, cancel the existing notification, and skip
 * rescheduling because that computed time is already in the past - silently killing the reminder
 * until the user notices and toggles it off/on. Mirrors deviceCalendarSync.ts's
 * refreshRecurringDeviceCalendarEntries (same "run on every foreground" shape) for the
 * notification side instead of the device-calendar side.
 */
export async function refreshRecurringReminders(): Promise<void> {
  if (!Notifications || Platform.OS === 'web') return;
  try {
    const events = await getLocalEvents();
    const now = new Date();
    for (const event of events) {
      if (event._pendingDelete || !event.recurrence || !event.reminder_minutes) continue;
      try {
        const start = new Date(event.start_time);
        if (Number.isNaN(start.getTime())) continue;

        // Only reads start_time/recurrence/timezone off its argument - LocalEvent carries all
        // three but isn't a full CalendarEvent, hence the cast (same pattern as
        // deviceCalendarSync.ts's refreshRecurringDeviceCalendarEntries).
        const pseudoEvent = {
          start_time: event.start_time,
          recurrence: event.recurrence,
          timezone: event.timezone ?? null,
        } as unknown as CalendarEvent;
        const next = nextOccurrenceOnOrAfter(pseudoEvent, now);
        if (!next) continue; // recurrence has ended (past `until`) - leave things as-is

        const reminderTime = new Date(next.getTime() - event.reminder_minutes * 60 * 1000);
        // This occurrence's reminder window already passed (e.g. reminder_minutes is small and
        // the occurrence is imminent) - leave the existing notification alone rather than cancel
        // it with nothing to replace it with; the occurrence after this one gets picked up on
        // the next foreground once `next` advances past it.
        if (reminderTime <= now) continue;

        if (event.local_notification_id) {
          try { await Notifications.cancelScheduledNotificationAsync(event.local_notification_id); } catch {}
        }
        const newId = await Notifications.scheduleNotificationAsync({
          content: {
            title: '⏰ Event Reminder',
            body: `"${event.title}" starts in ${reminderLabel(event.reminder_minutes)}`,
            sound: true,
          },
          trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: reminderTime },
        });
        await setLocalEventNotificationId(event.id, newId);
      } catch (e) {
        console.error('Failed to refresh recurring reminder for event', event.id, e);
      }
    }
  } catch (e) {
    console.error('refreshRecurringReminders failed:', e);
  }
}

/**
 * Wire up notification taps → open the linked event. Handles both a tap while running and a cold
 * start launched from the notification. Returns an unsubscribe fn.
 */
export function setupNotificationTapHandler(onOpenEvent: (eventId: string) => void): () => void {
  if (!Notifications) return () => {};
  const handle = (data: any) => {
    if (data?.kind === 'event-reminder' && data?.eventId) onOpenEvent(String(data.eventId));
  };
  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    handle(response.notification.request.content.data);
  });
  Notifications.getLastNotificationResponseAsync()
    .then((response) => response && handle(response.notification.request.content.data))
    .catch(() => {});
  return () => sub.remove();
}
