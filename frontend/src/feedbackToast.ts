/**
 * feedbackToast.ts
 * Tracks the lifetime note-created count and whether the "Enjoying Nueco?" feedback toast has
 * been resolved, so it fires after the 5th note - see src/components/FeedbackToast.tsx for the UI
 * and app/(tabs)/index.tsx for the two trigger points (cold launch, and returning to the notes
 * list).
 *
 * "Resolved" means the user gave a thumbs up/down, or dismissed a *retry* showing - see
 * handleFeedbackToastNoAction(). Dismissing (or letting time out) the *first* showing without
 * tapping thumbs up/down isn't treated as a real answer: it schedules a one-time retry 5 notes
 * later, which then stays up until manually dismissed (no auto-timeout) rather than snoozing
 * indefinitely.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';

const KEYS = {
  NOTE_COUNT: 'feedback_toast_note_count',
  SEEN: 'feedback_toast_seen',
  RETRY_AT_COUNT: 'feedback_toast_retry_at_count',
};

const MILESTONE_NOTE_COUNT = 5;

// Build-time kill switch (mirrors src/crypto/flags.ts's E2EE_KEYS_ENABLED/DIAGNOSTICS_ENABLED
// pattern) - flip `feedbackToast` to false in app.config.js and ship a new build to disable.
export const FEEDBACK_TOAST_ENABLED: boolean =
  Constants.expoConfig?.extra?.feedbackToast !== false;

export async function getNoteCreatedCount(): Promise<number> {
  const raw = await AsyncStorage.getItem(KEYS.NOTE_COUNT);
  return raw ? parseInt(raw, 10) || 0 : 0;
}

export async function incrementNoteCreatedCount(): Promise<number> {
  const next = (await getNoteCreatedCount()) + 1;
  await AsyncStorage.setItem(KEYS.NOTE_COUNT, String(next));
  return next;
}

export async function hasSeenFeedbackToast(): Promise<boolean> {
  return (await AsyncStorage.getItem(KEYS.SEEN)) === '1';
}

export async function markFeedbackToastSeen(): Promise<void> {
  await AsyncStorage.setItem(KEYS.SEEN, '1');
  await AsyncStorage.removeItem(KEYS.RETRY_AT_COUNT);
}

async function getRetryAtCount(): Promise<number | null> {
  const raw = await AsyncStorage.getItem(KEYS.RETRY_AT_COUNT);
  return raw ? parseInt(raw, 10) || null : null;
}

/** True when the pending showing is the retry (should stay up until manually dismissed). */
export async function isFeedbackToastRetry(): Promise<boolean> {
  return (await getRetryAtCount()) != null;
}

/**
 * Call when the toast is dismissed (X tap or auto-timeout) WITHOUT a thumbs up/down - i.e. the
 * user didn't actually answer. First time: schedules a one-time retry 5 notes later. Second time
 * (the retry itself being dismissed): gives up and marks it seen for good.
 */
export async function handleFeedbackToastNoAction(): Promise<void> {
  if (await isFeedbackToastRetry()) {
    await markFeedbackToastSeen();
    return;
  }
  const count = await getNoteCreatedCount();
  await AsyncStorage.setItem(KEYS.RETRY_AT_COUNT, String(count + MILESTONE_NOTE_COUNT));
}

export async function shouldShowFeedbackToast(): Promise<boolean> {
  if (!FEEDBACK_TOAST_ENABLED) return false;
  if (await hasSeenFeedbackToast()) return false;
  const [count, retryAt] = await Promise.all([getNoteCreatedCount(), getRetryAtCount()]);
  return retryAt != null ? count >= retryAt : count >= MILESTONE_NOTE_COUNT;
}
