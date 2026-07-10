/**
 * GDPR data portability (Art. 20): assemble the user's data into a readable JSON file and hand it to
 * the OS share sheet so they can save/send it.
 *
 * Notes are exported DECRYPTED from the local cache - the server only ever holds ciphertext, and the
 * local copy is the user's plaintext working set (encryption happens at the sync-push boundary). We
 * include both the raw HTML body and a plain-text rendering so the export is human-readable.
 */
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { getLocalNotes, getLocalEvents } from './offlineSync';
import { plainTextFromContent } from './textContent';

type ExportUser = { id: string; email: string; name: string } | null | undefined;

export async function exportMyData(user: ExportUser): Promise<void> {
  const [notes, events] = await Promise.all([getLocalNotes(), getLocalEvents()]);

  const payload = {
    app: 'MemoPad',
    format_version: 1,
    exported_at: new Date().toISOString(),
    profile: user ? { id: user.id, email: user.email, name: user.name } : null,
    notes: notes
      .filter((n) => !n._pendingDelete)
      .map((n) => ({
        id: n.id,
        title: n.title,
        content_html: n.content,
        content_text: plainTextFromContent(n.content || ''),
        tags: n.tags,
        is_pinned: n.is_pinned,
        linked_event_id: n.linked_event_id ?? null,
        created_at: n.created_at,
        updated_at: n.updated_at,
      })),
    events: events
      .filter((e) => !e._pendingDelete)
      .map((e) => ({
        id: e.id,
        title: e.title,
        description: e.description,
        start_time: e.start_time,
        end_time: e.end_time,
        reminder_minutes: e.reminder_minutes ?? null,
        created_at: e.created_at,
      })),
  };

  const json = JSON.stringify(payload, null, 2);
  const fileUri = `${FileSystem.documentDirectory}memopad-export-${Date.now()}.json`;
  await FileSystem.writeAsStringAsync(fileUri, json);

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(fileUri, {
      mimeType: 'application/json',
      dialogTitle: 'Export MemoPad data',
      UTI: 'public.json',
    });
  }
}
