export interface Tag {
  name: string;
  color: string;
}

export interface Attachment {
  id: string;
  key: string;
  url: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  uploaded_at: string;
}

// A free-floating, drag/pinch/rotate-able image layered over the note's text - distinct from
// the plain `images` gallery (base64 thumbnails, no transforms) and from `Attachment` (arbitrary
// files). Mirrors backend/notes/schemas.py's ImageObject.
export interface NoteObject {
  id: string;
  type: 'image';
  local_uri: string | null;
  remote_url: string | null; // informational only - the bucket is private, never fetched directly
  key: string | null; // S3 object key - needed for delete-cleanup and re-minting a download URL
  intrinsic_width: number;
  intrinsic_height: number;
  x: number; // normalized 0..1, relative to canvas WIDTH (both axes - see noteObjectsCore.ts)
  y: number;
  scale: number; // uniform, relative to a base display width
  rotation: number; // radians
  z: number;
  upload_status: 'pending' | 'uploaded' | 'failed';
}

export interface Note {
  id: string;
  title: string;
  content: string;
  tags: Tag[];
  is_pinned: boolean;
  linked_event_id: string | null; // Deprecated: use linked_event_ids. Kept for old clients.
  linked_event_ids: string[];
  attachments?: Attachment[];
  objects?: NoteObject[];
  has_attachments?: boolean;
  created_at: string;
  updated_at: string;
}

// Reminder options in minutes before event
export type ReminderMinutes = 5 | 15 | 30 | 60 | 1440; // 1440 = 1 day

export type RecurrenceFreq = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface Recurrence {
  freq: RecurrenceFreq;
  byweekday: number[] | null; // 0=Sun..6=Sat (matches JS Date.getDay())
  until: string | null; // ISO date string, inclusive
}

export interface CalendarEvent {
  id: string;
  title: string;
  description: string;
  location: string;
  // When true, start_time/end_time are date-only "YYYY-MM-DD" (a calendar date, not an
  // instant) - never converted to/from local time. When false/absent (legacy events predating
  // this field), they're full ISO-8601 instants, converted to local time for display as usual.
  all_day?: boolean;
  start_time: string;
  end_time: string;
  linked_note_ids: string[];
  reminder_minutes: ReminderMinutes | null;
  device_calendar_event_id: string | null;
  created_at: string;
  recurrence: Recurrence | null;
  timezone: string | null;
  trip_id: string | null; // Groups this event under a Trip (itinerary view) - see Trip below.
}

export interface Trip {
  id: string;
  name: string;
  description: string;
  created_at: string;
}

// One event as extracted by the backend's voice-intent classifier - see
// backend/textai/schemas.py's VoiceEventOut. Not yet saved: the user confirms/edits before
// this becomes a real CalendarEvent via createEventOffline.
export interface ExtractedEvent {
  title: string;
  start_time: string;
  end_time: string | null;
  location: string;
  recurrence: Recurrence | null;
  confidence: 'high' | 'low';
}

export type VoiceIntent = 'note' | 'single_event' | 'multiple_events' | 'itinerary';

// What the note editor's mic button gets back from POST /classify-voice-intent, before the
// user has confirmed anything.
export interface VoiceIntentResult {
  intent: VoiceIntent;
  trip_name: string | null;
  events: ExtractedEvent[];
}
