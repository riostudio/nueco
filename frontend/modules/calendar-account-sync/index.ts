import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

const CalendarAccountSync = Platform.OS === 'android' ? requireOptionalNativeModule('CalendarAccountSync') : null;

// Best-effort nudge for Android's account sync adapter - see the Kotlin module for why. No-op on
// iOS (Apple Calendar has no comparable "sync now" hook, and none is needed - EventKit writes
// there push to iCloud/Exchange promptly on their own) and when the native module isn't present
// (e.g. Expo Go).
export function requestCalendarAccountSync(accountName: string | undefined, accountType: string | undefined) {
  if (!CalendarAccountSync || !accountName || !accountType) return;
  try {
    CalendarAccountSync.requestSync(accountName, accountType);
  } catch {}
}
