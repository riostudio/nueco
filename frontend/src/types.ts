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
  scan_status?: string; // in-memory malware-scan state ('CLEAN'|'PENDING'|'INFECTED'|...)
}

export interface Note {
  id: string;
  title: string;
  content: string;
  tags: Tag[];
  is_pinned: boolean;
  linked_event_id: string | null;
  attachments?: Attachment[];
  has_attachments?: boolean;
  created_at: string;
  updated_at: string;
}

// Reminder options in minutes before event
export type ReminderMinutes = 5 | 15 | 30 | 60 | 1440; // 1440 = 1 day

export interface CalendarEvent {
  id: string;
  title: string;
  description: string;
  start_time: string;
  end_time: string;
  linked_note_ids: string[];
  reminder_minutes: ReminderMinutes | null;
  device_calendar_event_id: string | null;
  created_at: string;
}
