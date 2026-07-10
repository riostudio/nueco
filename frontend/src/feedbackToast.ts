/**
 * feedbackToast.ts
 * Tracks the lifetime note-created count and whether the one-time "Enjoying MemoPad?" feedback
 * toast has been shown, so it fires exactly once per user after their 5th note - see
 * src/components/FeedbackToast.tsx for the UI and app/(tabs)/_layout.tsx / app/(tabs)/index.tsx
 * for the two trigger points (cold launch, and returning to the notes list).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';

const KEYS = {
  NOTE_COUNT: 'feedback_toast_note_count',
  SEEN: 'feedback_toast_seen',
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
}

export async function shouldShowFeedbackToast(): Promise<boolean> {
  if (!FEEDBACK_TOAST_ENABLED) return false;
  const [count, seen] = await Promise.all([getNoteCreatedCount(), hasSeenFeedbackToast()]);
  return count >= MILESTONE_NOTE_COUNT && !seen;
}
