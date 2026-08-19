import PostHog from 'posthog-react-native';
import * as Device from 'expo-device';
import * as Application from 'expo-application';
import { Platform, Dimensions } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// GDPR opt-IN consent: usage analytics stay OFF until the user explicitly grants consent. Stored as
// 'granted' | 'denied'; unset = undecided (treated as OFF). capture() no-ops until granted.
const ANALYTICS_CONSENT_KEY = 'analytics_consent';

export const getAnalyticsConsent = async (): Promise<'granted' | 'denied' | null> => {
  try { return (await AsyncStorage.getItem(ANALYTICS_CONSENT_KEY)) as 'granted' | 'denied' | null; }
  catch { return null; }
};

/** Whether the user has already answered the consent prompt (so we don't ask again). */
export const hasAnalyticsDecision = async (): Promise<boolean> => {
  const v = await getAnalyticsConsent();
  return v === 'granted' || v === 'denied';
};

export const isAnalyticsEnabled = async (): Promise<boolean> =>
  (await getAnalyticsConsent()) === 'granted';

export const setAnalyticsEnabled = async (enabled: boolean): Promise<void> => {
  try { await AsyncStorage.setItem(ANALYTICS_CONSENT_KEY, enabled ? 'granted' : 'denied'); } catch {}
  if (posthogInstance) {
    if (enabled) posthogInstance.optIn();
    else posthogInstance.optOut();
  }
};

// PostHog configuration
const POSTHOG_API_KEY = process.env.EXPO_PUBLIC_POSTHOG_KEY || '';
const POSTHOG_HOST = process.env.EXPO_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com';

// Initialize PostHog instance
let posthogInstance: PostHog | null = null;

export const initPostHog = async (userId?: string): Promise<PostHog | null> => {
  if (!POSTHOG_API_KEY) {
    console.log('PostHog API key not configured, analytics disabled');
    return null;
  }

  if (posthogInstance) {
    return posthogInstance;
  }

  try {
    posthogInstance = new PostHog(POSTHOG_API_KEY, {
      host: POSTHOG_HOST,
      enableSessionReplay: false, // Session replay not supported in Expo Go
      // Note: autocapture/screen-view capture is configured on <PostHogProvider>,
      // not in constructor options (posthog-react-native v4).
    });

    // Register super properties (global properties for all events)
    const superProperties = await getSuperProperties();
    posthogInstance.register(superProperties);

    // Identify user if provided
    if (userId) {
      posthogInstance.identify(userId);
    }

    // Respect a saved opt-out (GDPR) - capture() no-ops while opted out.
    if (!(await isAnalyticsEnabled())) {
      posthogInstance.optOut();
    }

    console.log('PostHog initialized successfully');
    return posthogInstance;
  } catch (error) {
    console.error('Failed to initialize PostHog:', error);
    return null;
  }
};

// Get super properties that will be attached to every event
const getSuperProperties = async () => {
  const { width, height } = Dimensions.get('window');
  
  return {
    platform: Platform.OS === 'ios' ? 'iOS' : Platform.OS === 'android' ? 'Android' : 'Web',
    device_model: Device.modelName || 'Unknown',
    os_version: `${Platform.OS === 'ios' ? 'iOS' : Platform.OS === 'android' ? 'Android' : 'Web'} ${Platform.Version}`,
    app_version: Application.nativeApplicationVersion || '1.0.0',
    screen_size: `${width}x${height}`,
    device_brand: Device.brand || 'Unknown',
    device_type: Device.deviceType ? getDeviceTypeName(Device.deviceType) : 'Unknown',
  };
};

const getDeviceTypeName = (deviceType: number): string => {
  switch (deviceType) {
    case 1: return 'Phone';
    case 2: return 'Tablet';
    case 3: return 'Desktop';
    case 4: return 'TV';
    default: return 'Unknown';
  }
};

// Get PostHog instance
export const getPostHog = (): PostHog | null => posthogInstance;

// Identify user (call after login)
export const identifyUser = (userId: string, properties?: Record<string, any>) => {
  if (!posthogInstance) return;
  
  // Use anonymized user ID (hash or truncate if needed)
  const anonymizedId = `user_${userId.substring(0, 8)}`;
  posthogInstance.identify(anonymizedId, properties);
};

// Reset user (call after logout)
export const resetUser = () => {
  if (!posthogInstance) return;
  posthogInstance.reset();
};

// ============================================
// NOTE EVENTS
// ============================================

interface NoteCreatedProperties {
  has_scheduled_event: boolean;
  has_image_attached: boolean;
  is_shared: boolean;
  // How the note's content actually got there. Without this, note_created fires identically
  // whether someone typed or dictated, so "did onboarding succeed in getting a first note
  // captured BY VOICE" is unanswerable - which is the single thing the voice-first onboarding
  // exists to move.
  source?: 'voice' | 'typed';
}

/** Onboarding funnel steps, in order. Each fires once as the user reaches that screen. */
export type OnboardingStep = 'started' | 'permission_granted' | 'permission_denied' | 'recorded' | 'note_saved' | 'skipped' | 'completed';

export const trackOnboardingStep = (step: OnboardingStep) => {
  if (!posthogInstance) return;
  posthogInstance.capture('onboarding_step', {
    step,
    timestamp: new Date().toISOString(),
  });
};

export const trackNoteCreated = (properties: NoteCreatedProperties) => {
  if (!posthogInstance) return;
  posthogInstance.capture('note_created', {
    ...properties,
    timestamp: new Date().toISOString(),
  });
};

export const trackNoteEdited = () => {
  if (!posthogInstance) return;
  posthogInstance.capture('note_edited', {
    timestamp: new Date().toISOString(),
  });
};

export const trackNoteDeleted = () => {
  if (!posthogInstance) return;
  posthogInstance.capture('note_deleted', {
    timestamp: new Date().toISOString(),
  });
};

export const trackNoteSearched = (queryLength: number) => {
  if (!posthogInstance) return;
  posthogInstance.capture('note_searched', {
    query_length: queryLength,
    timestamp: new Date().toISOString(),
  });
};

// ============================================
// NOTE FEATURE EVENTS
// ============================================

export const trackNoteEventScheduled = () => {
  if (!posthogInstance) return;
  posthogInstance.capture('note_event_scheduled', {
    timestamp: new Date().toISOString(),
  });
};

export const trackNoteImageAttached = (imageCount: number) => {
  if (!posthogInstance) return;
  posthogInstance.capture('note_image_attached', {
    image_count: imageCount,
    timestamp: new Date().toISOString(),
  });
};

type ShareMethod = 'link' | 'email' | 'message' | 'social' | 'other';

export const trackNoteShared = (shareMethod: ShareMethod) => {
  if (!posthogInstance) return;
  posthogInstance.capture('note_shared', {
    share_method: shareMethod,
    timestamp: new Date().toISOString(),
  });
};

// ============================================
// VOICE-TO-TEXT EVENTS
// ============================================

export const trackVoiceRecordingStarted = () => {
  if (!posthogInstance) return;
  posthogInstance.capture('voice_recording_started', {
    timestamp: new Date().toISOString(),
  });
};

export const trackVoiceRecordingCompleted = (recordingDurationSeconds: number) => {
  if (!posthogInstance) return;
  posthogInstance.capture('voice_recording_completed', {
    recording_duration_seconds: recordingDurationSeconds,
    timestamp: new Date().toISOString(),
  });
};

export const trackVoiceRecordingCancelled = () => {
  if (!posthogInstance) return;
  posthogInstance.capture('voice_recording_cancelled', {
    timestamp: new Date().toISOString(),
  });
};

export const trackVoiceTranscriptionInserted = (
  recordingDurationSeconds: number,
  transcriptWordCount: number
) => {
  if (!posthogInstance) return;
  posthogInstance.capture('voice_transcription_inserted', {
    recording_duration_seconds: recordingDurationSeconds,
    transcript_word_count: transcriptWordCount,
    timestamp: new Date().toISOString(),
  });
};

// ============================================
// PHASE 1 INSTRUMENTATION (A0)
// Content-free by contract: these events carry ONLY booleans, timestamps,
// counts, enum types, and model metadata (confidence). Never transcript,
// note, or artifact text — plaintext or otherwise.
// All per-capture events share `capture_id` (a random correlation id with
// no content), and PostHog's anonymized distinct id joins them per user to
// retention cohorts (D2/D7/D30).
// ============================================

export type ArtifactType = 'event' | 'shopping_item' | 'checklist_item' | 'trip';

/** Opaque per-capture correlation id. No content — random at capture start. */
export const newCaptureId = (): string =>
  `cap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

export interface RevealFiredProperties {
  capture_id: string;
  /** Where the reveal happened — A3 (onboarding) and A5 (editor) MUST stay comparable. */
  surface: 'onboarding' | 'editor';
  /** Wall-clock length of the reveal transition itself. */
  reveal_duration_ms: number;
  /** What produced the content being revealed. */
  trigger: 'structuring_complete' | 'offline_sync_complete';
}

/** Fires when the reveal transition animation COMPLETES — not when the structuring API responds. */
export const trackRevealFired = (properties: RevealFiredProperties) => {
  if (!posthogInstance) return;
  posthogInstance.capture('reveal_fired', {
    ...properties,
    timestamp: new Date().toISOString(),
  });
};

export interface ExtractionResultProperties {
  capture_id: string;
  artifact_types: ArtifactType[];
  item_count: number;
  /** Model confidence per extracted item — metadata, not content. */
  confidences: number[];
  source_span_present_count: number;
  source_span_missing_count: number;
}

/** Fires once per capture with what extraction produced. */
export const trackExtractionResult = (properties: ExtractionResultProperties) => {
  if (!posthogInstance) return;
  posthogInstance.capture('extraction_result', {
    ...properties,
    timestamp: new Date().toISOString(),
  });
};

export interface SaveOutcomeProperties {
  capture_id: string;
  raw_save: 'ok' | 'fail';
  structuring: 'ok' | 'fail' | 'timeout' | 'skipped';
  offline_queued: boolean;
  /** Which transcription engine handled the capture - metadata, not content. */
  engine?: 'cloud' | 'local';
}

/** Fires once per capture when the save path settles. */
export const trackSaveOutcome = (properties: SaveOutcomeProperties) => {
  if (!posthogInstance) return;
  posthogInstance.capture('save_outcome', {
    ...properties,
    timestamp: new Date().toISOString(),
  });
};

export interface ArtifactDismissedProperties {
  capture_id: string;
  artifact_type: ArtifactType;
  /** Model confidence of the dismissed suggestion — metadata, not content. */
  confidence: number;
}

export const trackArtifactDismissed = (properties: ArtifactDismissedProperties) => {
  if (!posthogInstance) return;
  posthogInstance.capture('artifact_dismissed', {
    ...properties,
    timestamp: new Date().toISOString(),
  });
};

// Segment latency: VAD segment-end → artifact appearance. Two half-calls so the
// start (segment boundary) and end (reveal complete) can live in different flows.
let segmentEndAt: number | null = null;

/** Call at the VAD segment boundary (pause detected / segment handed to transcription). */
export const markSegmentEnd = () => {
  segmentEndAt = Date.now();
};

/** Call when the segment's artifacts appear; fires segment_latency and clears the marker. */
export const trackSegmentLatency = () => {
  if (segmentEndAt === null) return;
  const segment_latency_ms = Date.now() - segmentEndAt;
  segmentEndAt = null;
  if (!posthogInstance) return;
  posthogInstance.capture('segment_latency', {
    segment_latency_ms,
    timestamp: new Date().toISOString(),
  });
};

// ============================================
// GENERIC EVENT TRACKING
// ============================================

export const trackEvent = (eventName: string, properties?: Record<string, any>) => {
  if (!posthogInstance) return;
  posthogInstance.capture(eventName, {
    ...properties,
    timestamp: new Date().toISOString(),
  });
};

// Flush events (call before app closes or when critical)
export const flushEvents = () => {
  if (!posthogInstance) return;
  posthogInstance.flush();
};

export default {
  initPostHog,
  getPostHog,
  identifyUser,
  resetUser,
  trackNoteCreated,
  trackNoteEdited,
  trackNoteDeleted,
  trackNoteSearched,
  trackNoteEventScheduled,
  trackNoteImageAttached,
  trackNoteShared,
  trackVoiceRecordingStarted,
  trackVoiceRecordingCompleted,
  trackVoiceRecordingCancelled,
  trackVoiceTranscriptionInserted,
  trackEvent,
  flushEvents,
  newCaptureId,
  trackRevealFired,
  trackExtractionResult,
  trackSaveOutcome,
  trackArtifactDismissed,
  markSegmentEnd,
  trackSegmentLatency,
};
