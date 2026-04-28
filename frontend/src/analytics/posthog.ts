import PostHog from 'posthog-react-native';
import * as Device from 'expo-device';
import * as Application from 'expo-application';
import { Platform, Dimensions } from 'react-native';

// PostHog configuration
const POSTHOG_API_KEY = process.env.EXPO_PUBLIC_POSTHOG_KEY || '';
const POSTHOG_HOST = 'https://us.i.posthog.com';

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
      captureScreenViews: true,
      autocapture: true,
    });

    // Register super properties (global properties for all events)
    const superProperties = await getSuperProperties();
    posthogInstance.register(superProperties);

    // Identify user if provided
    if (userId) {
      posthogInstance.identify(userId);
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
}

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
};
