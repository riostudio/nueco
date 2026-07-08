/**
 * Push-notification registration + handlers for event reminders (Phase 2).
 *
 * The backend fires reminders as Expo push messages (see server.py /internal/push/tick). Here we:
 *  - register this device's Expo push token with the backend (on login),
 *  - unregister it on logout,
 *  - present reminders while the app is foregrounded,
 *  - deep-link into the event when a reminder is tapped.
 *
 * All best-effort: push may be unavailable (web, no permission, FCM/APNs not configured) — nothing
 * here throws into the app.
 */
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { pushApi } from './api';

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
      await Notifications.setNotificationChannelAsync(EVENT_REMINDER_CHANNEL, {
        name: 'Event reminders',
        importance: Notifications.AndroidImportance.HIGH,
        sound: 'default',
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
