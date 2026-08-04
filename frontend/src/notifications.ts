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
import { speakReminder, reminderSpeechFor } from './reminderVoice';
import { getLocalEvents, setLocalEventNotificationId } from './offlineSync';
import { nextOccurrenceOnOrAfter } from './recurrence';
import type { CalendarEvent } from './types';

let Notifications: typeof import('expo-notifications') | null = null;
if (Platform.OS !== 'web') {
  try { Notifications = require('expo-notifications'); } catch {}
}

const STORED_TOKEN_KEY = 'expo_push_token';
/** Launch notification already acted on this app session (see setupNotificationTapHandler). */
let handledLaunchNotificationId: string | null = null;
export const EVENT_REMINDER_CHANNEL = 'event-reminders';
/**
 * Separate channel carrying the spoken reminder sound.
 *
 * A NEW id is required, not a tweak to the one above: on Android a channel's sound is fixed at
 * creation and every later update is ignored, so an existing install would keep the default tone
 * forever. Bumping the id is the only way to change it.
 *
 * This is also the ONLY way a voice plays at the moment a reminder fires while the app is
 * backgrounded or killed - the OS plays this file itself, because our JavaScript is not running.
 * That's also why the phrase is generic: the event title isn't known when the app is built.
 */
import { EVENT_REMINDER_VOICE_CHANNEL, REMINDER_SOUND_FILE, reminderSoundConfig } from './reminderVoice';
export { EVENT_REMINDER_VOICE_CHANNEL, REMINDER_SOUND_FILE };

/** Show reminders as a banner (with sound) while the app is open. */
export function setupNotificationHandler(): void {
  if (!Notifications) return;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      // Always on: the notification's own sound is the only reminder audio now, in every state.
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
      // Spoken variant. Created up front so it's ready the first time a user enables the option.
      await Notifications.setNotificationChannelAsync(EVENT_REMINDER_VOICE_CHANNEL, {
        name: 'Spoken event reminders',
        importance: Notifications.AndroidImportance.HIGH,
        sound: REMINDER_SOUND_FILE,
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
        // Resolved per notification: the sound has to be baked in at schedule time, since the OS
        // plays it with no code of ours running.
        const soundCfg = await reminderSoundConfig();
        const newId = await Notifications.scheduleNotificationAsync({
          content: {
            title: '⏰ Event Reminder',
            body: `"${event.title}" starts in ${reminderLabel(event.reminder_minutes)}`,
            sound: soundCfg.sound,
            // Carried so the foreground/tap handlers can speak the reminder without re-reading
            // the event from the DB (see src/reminderVoice.ts for why only those two moments
            // can ever run our code).
            data: {
              kind: 'event-reminder',
              eventId: event.id,
              speakTitle: event.title,
              speakWhen: `starts in ${reminderLabel(event.reminder_minutes)}`,
            },
          },
          trigger: {
            type: Notifications.SchedulableTriggerInputTypes.DATE,
            date: reminderTime,
            channelId: soundCfg.channelId,
          },
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

  // Takes the whole notification CONTENT, not just `data`: reminders scheduled by an older app
  // version (already queued in the OS, impossible to retro-fit) and backend pushes carry no
  // speech fields, so the visible title/body is the only thing left to read out.
  // A reminder that arrives while the app is OPEN and is then TAPPED reaches both listeners
  // below, so without this the same reminder is announced twice, overlapping itself.
  const spokenIds = new Set<string>();

  const speak = (content: any, notificationId?: string) => {
    if (notificationId) {
      if (spokenIds.has(notificationId)) return;
      spokenIds.add(notificationId);
    }
    const data = content?.data;
    // Every notification this app produces is an event reminder, so an untagged one (i.e. queued
    // before the payload existed) is still spoken; anything explicitly tagged as something else
    // is not.
    if (data?.kind && data.kind !== 'event-reminder') return;
    void speakReminder(
      reminderSpeechFor({
        speakTitle: data?.speakTitle == null ? null : String(data.speakTitle),
        speakWhen: data?.speakWhen == null ? null : String(data.speakWhen),
        title: content?.title ?? null,
        body: content?.body ?? null,
      }),
    );
  };

  const handle = (content: any, notificationId?: string) => {
    speak(content, notificationId);
    const data = content?.data;
    if (data?.eventId) onOpenEvent(String(data.eventId));
  };

  // Fires only while the app is in the FOREGROUND. This is one of the two moments our code can
  // run for a reminder at all - the OS handles background delivery entirely on its own.
  // No delivery-time speech, in ANY app state. The notification carries the bundled voice clip,
  // and on Android 8+ the channel controls sound - the foreground handler cannot reliably
  // suppress it across OEMs, so speaking here risked the clip and the speech playing over each
  // other. One sound when a reminder fires, always: the clip.
  //
  // Speech survives only on TAP below, where nothing else is playing and the chosen voice can
  // read out the actual event title - which is also what keeps the voice picker meaningful.
  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    handle(response.notification.request.content, response.notification.request.identifier);
  });
  // Cold start from a tapped notification. Guarded by identifier because this resolves on every
  // mount of the layout that installs these handlers, and the OS keeps returning the SAME launch
  // response - without the guard a remount re-opens the event and, now that it speaks too,
  // re-announces a reminder the user dealt with long ago.
  Notifications.getLastNotificationResponseAsync()
    .then((response) => {
      if (!response) return;
      const id = response.notification.request.identifier;
      if (id && id === handledLaunchNotificationId) return;
      handledLaunchNotificationId = id ?? null;
      handle(response.notification.request.content);
    })
    .catch(() => {});
  return () => { sub.remove(); };
}
