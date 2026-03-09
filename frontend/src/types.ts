export interface Tag {
  name: string;
  color: string;
}

export interface Note {
  id: string;
  title: string;
  content: string;
  tags: Tag[];
  is_pinned: boolean;
  linked_event_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  description: string;
  start_time: string;
  end_time: string;
  linked_note_ids: string[];
  created_at: string;
}
