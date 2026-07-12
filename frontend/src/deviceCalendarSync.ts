import { Platform } from 'react-native';
import { requestCalendarAccountSync } from '../modules/calendar-account-sync';

let ExpoCalendar: typeof import('expo-calendar') | null = null;
if (Platform.OS !== 'web') {
  try { ExpoCalendar = require('expo-calendar'); } catch {}
}

// Nudges Android's account sync adapter for every synced calendar on the device, right after a
// device-calendar write/delete, so the change reaches Google/Exchange servers immediately instead
// of waiting for the OS's normal periodic sync window. Best-effort: no-op on iOS/web, and swallows
// errors - this is a speedup, not something a save/delete should ever fail over.
export async function bumpDeviceCalendarSync(): Promise<void> {
  if (Platform.OS !== 'android' || !ExpoCalendar) return;
  try {
    const cals = await ExpoCalendar.getCalendarsAsync(ExpoCalendar.EntityTypes.EVENT);
    const seen = new Set<string>();
    for (const c of cals as any[]) {
      if (c.source?.isLocalAccount === true || !c.source?.name || !c.source?.type) continue;
      const key = `${c.source.name}|${c.source.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      requestCalendarAccountSync(c.source.name, c.source.type);
    }
  } catch {}
}
