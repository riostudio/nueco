/**
 * Speaks event reminders aloud, using whatever the user chose in the reminder-voice picker.
 *
 * IMPORTANT LIMITATION - read before extending this.
 * Reminders are OS-scheduled local notifications. When one fires while the app is backgrounded or
 * killed, the operating system renders it and OUR JAVASCRIPT NEVER RUNS - so nothing here can
 * execute at that moment. Speaking aloud is therefore only possible when:
 *
 *   1. the app is in the foreground when the reminder fires, or
 *   2. the user taps the notification (which launches/foregrounds us).
 *
 * True background speech would need the audio baked into the notification itself as a custom
 * sound. That is feasible for a RECORDED clip (a static file), but not for spoken event titles:
 * expo-speech can only play synthesised audio, it cannot render it to a file, so there is nothing
 * to attach at schedule time. Doing that properly means a native TTS-to-file module.
 */
import * as Speech from 'expo-speech';
import { setAudioModeAsync } from 'expo-audio';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const REMINDER_VOICE_PREF_KEY = 'reminder_voice_pref';

/** Bundled at build time by the expo-notifications config plugin (app.json `sounds`). */
export const REMINDER_SOUND_FILE = 'nueco_reminder.wav';
export const EVENT_REMINDER_CHANNEL = 'event-reminders';
export const EVENT_REMINDER_VOICE_CHANNEL = 'event-reminders-voice-v1';

type Pref =
  | { mode: 'off' }
  | { mode: 'device'; voiceId?: string | null; language?: string | null };

async function readPref(): Promise<Pref> {
  try {
    const raw = await AsyncStorage.getItem(REMINDER_VOICE_PREF_KEY);
    if (!raw) return { mode: 'off' };
    const p = JSON.parse(raw);
    return p?.mode === 'device' ? p : { mode: 'off' };
  } catch {
    return { mode: 'off' };
  }
}

/**
 * Speaks a reminder if the user has enabled it. Safe to call unconditionally - it resolves
 * quietly when the feature is off, unconfigured, or unavailable.
 *
 */
export async function speakReminder(text: string): Promise<void> {
  const pref = await readPref();
  if (pref.mode === 'off') return;

  try {
    // Reminders should be audible even with the ringer switch off - this is an alert the user
    // explicitly asked for, not incidental media.
    await setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});

    // A stored voice identifier can stop existing (OS update, a downloaded voice removed in
    // Settings, restoring a backup onto another device). expo-speech REJECTS rather than falling
    // back in that case, and because Speech.speak() doesn't return the promise it rejects
    // unhandled - i.e. total silence with nothing caught here. Drop an unknown id and let the
    // language pick a voice instead.
    let voice = pref.voiceId || undefined;
    if (voice) {
      try {
        const available = await Speech.getAvailableVoicesAsync();
        if (!available.some(v => v.identifier === voice)) voice = undefined;
      } catch {
        // Couldn't check - keep the stored id and let it try.
      }
    }

    Speech.stop();
    // Pass voice OR language, never both.
    //
    // expo-speech's Android implementation (SpeechModule.kt speakOut) assigns
    // `textToSpeech.language` from `options.language` BEFORE applying `options.voice`, and it
    // builds that locale with `Locale(tag)` - a constructor that treats the ENTIRE string as the
    // language code, so a real BCP-47 tag like "en-AU" is not a recognised language and it falls
    // back to `Locale.getDefault()`. Assigning the language resets the engine's selected voice,
    // which is why a specifically chosen voice came out as the system default on Android.
    //
    // A chosen voice already carries its own locale, so the language is redundant alongside it.
    // Language is only used as the fallback when no specific voice is stored.
    Speech.speak(text, voice ? { voice } : { language: pref.language || undefined });
  } catch (e) {
    // Never let a failed announcement break reminder handling - the notification itself is the
    // primary signal; speech is an enhancement on top of it.
    console.warn('speakReminder failed:', e);
  }
}

/** Builds the sentence spoken for an event reminder. */
export function reminderSpeechText(title: string, whenLabel?: string): string {
  const clean = (title || '').trim() || 'your event';
  return whenLabel ? `Reminder. ${clean}, ${whenLabel}.` : `Reminder. ${clean}.`;
}

/** What a reminder notification can tell us about itself. Plain data - no expo types cross here. */
export type ReminderSpeechSource = {
  /** From our own `data` payload, when the notification was scheduled with one. */
  speakTitle?: string | null;
  speakWhen?: string | null;
  /** The notification's visible text, used when the payload is absent. */
  title?: string | null;
  body?: string | null;
};

/**
 * Derives what to say from whatever the notification actually carries.
 *
 * Three kinds of reminder reach us and only the first carries speech fields:
 *   1. locally scheduled by this app version -> speakTitle/speakWhen,
 *   2. a backend push (reminders/service.py) -> title "⏰ <event title>", body "Starts in ...",
 *   3. scheduled by an OLDER app version and still sitting in the OS queue -> title
 *      "⏰ Event Reminder", body '"<event title>" starts in ...'.
 * Falling back to the visible text keeps 2 and 3 audible instead of announcing "your event",
 * which matters because an already-scheduled reminder can't be retro-fitted with a payload.
 */
export function reminderSpeechFor(src: ReminderSpeechSource): string {
  const speakTitle = (src.speakTitle || '').trim();
  if (speakTitle) return reminderSpeechText(speakTitle, (src.speakWhen || '').trim() || undefined);

  // Both notification titles are built by us and prefixed with this bell.
  const title = (src.title || '').replace(/^⏰\s*/, '').trim();
  // The quotes read as nothing useful out loud.
  const body = (src.body || '').replace(/["“”]/g, '').trim();

  if (title && !/^event reminder$/i.test(title)) {
    const when = body ? body.charAt(0).toLowerCase() + body.slice(1) : undefined;
    return reminderSpeechText(title, when);
  }
  if (body) return `Reminder. ${body}.`;
  return reminderSpeechText('');
}


/**
 * Which sound + Android channel a reminder should be scheduled with.
 *
 * Call this at SCHEDULE time. The choice has to be baked into the notification itself, because
 * when it fires in the background the OS plays the sound on its own - there is no moment for our
 * code to decide anything.
 *
 * Applies to both voice modes on purpose. A user-recorded clip cannot be a notification sound
 * (only files bundled at build time can be), so the bundled phrase stands in for it at fire time;
 * the actual recording still plays on tap or in the foreground, where our code does run.
 */
export async function reminderSoundConfig(): Promise<{ sound: string | boolean; channelId: string }> {
  const pref = await readPref();
  const spoken = pref.mode !== 'off';
  return {
    sound: spoken ? REMINDER_SOUND_FILE : true,
    channelId: spoken ? EVENT_REMINDER_VOICE_CHANNEL : EVENT_REMINDER_CHANNEL,
  };
}
