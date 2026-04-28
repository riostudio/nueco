// Analytics module exports
export { PostHogProvider, usePostHogContext } from './PostHogProvider';
export { 
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
} from './posthog';
