/**
 * calendarSyncTask.ts
 * Registers `runCalendarSync` as a best-effort OS background task (iOS BGTaskScheduler / Android
 * WorkManager under the hood). `TaskManager.defineTask` must run at module scope so the OS can
 * invoke it during a headless launch that never reaches the tabs layout - this file is imported
 * for its side effect from the root app/_layout.tsx, the same way this repo already side-effect
 * imports react-native-get-random-values / src/crypto/kdf-native there.
 *
 * Both platforms treat the requested interval as a floor, not a guarantee - real-world gaps
 * between firings can stretch to hours depending on battery/usage/charging state. The foreground
 * sync call (in app/(tabs)/_layout.tsx) is what actually keeps things reliably up to date; this is
 * a bonus layer for when the app isn't opened for a while.
 */
import { Platform } from 'react-native';
import { runCalendarSync } from './calendarSync';

export const CALENDAR_SYNC_TASK = 'memopad-calendar-sync';

let TaskManager: typeof import('expo-task-manager') | null = null;
let BackgroundTask: typeof import('expo-background-task') | null = null;
if (Platform.OS !== 'web') {
  try { TaskManager = require('expo-task-manager'); } catch {}
  try { BackgroundTask = require('expo-background-task'); } catch {}
}

if (TaskManager && !TaskManager.isTaskDefined(CALENDAR_SYNC_TASK)) {
  TaskManager.defineTask(CALENDAR_SYNC_TASK, async () => {
    try {
      await runCalendarSync();
      return BackgroundTask?.BackgroundTaskResult.Success;
    } catch (e) {
      console.error('Calendar sync background task failed:', e);
      return BackgroundTask?.BackgroundTaskResult.Failed;
    }
  });
}

// One-time OS registration - safe to call on every launch, guarded so it's a no-op after the
// first successful registration.
export async function registerCalendarSyncTaskAsync(): Promise<void> {
  if (!TaskManager || !BackgroundTask || Platform.OS === 'web') return;
  try {
    const already = await TaskManager.isTaskRegisteredAsync(CALENDAR_SYNC_TASK);
    if (already) return;
    await BackgroundTask.registerTaskAsync(CALENDAR_SYNC_TASK, {
      minimumInterval: 15, // minutes; a floor, not a guarantee - see file header.
    });
  } catch (e) {
    console.error('Failed to register calendar sync background task:', e);
  }
}
