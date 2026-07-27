/**
 * Pure decision logic for calendarSync.ts: given the current device-calendar read and the
 * previously-recorded sync state, decides which MemoPad events to create/update/delete. No
 * AsyncStorage/ExpoCalendar/network calls in this file, so the sync rules - including the
 * conservative-deletion safety check - are unit-testable without a device SDK or backend.
 */

export type DeviceEvent = {
  id: string;
  title: string | null | undefined;
  location: string | null | undefined;
  notes: string | null | undefined;
  startDate: string | Date;
  endDate: string | Date;
};

export type EventPayload = {
  title: string;
  description: string;
  location: string;
  start_time: string;
  end_time: string;
};

export type CreatePayload = EventPayload & {
  linked_note_ids: string[];
  reminder_minutes: null;
  device_calendar_event_id: string;
};

export type SyncAction =
  | { kind: 'update'; memoId: string; deviceId: string; payload: EventPayload }
  | { kind: 'create'; deviceId: string; payload: CreatePayload }
  | { kind: 'delete'; memoId: string; deviceId: string };

export function hashDeviceEvent(e: {
  title: string;
  location: string;
  notes: string;
  startDate: string | Date;
  endDate: string | Date;
}): string {
  return [e.title, e.location, e.notes, new Date(e.startDate).toISOString(), new Date(e.endDate).toISOString()].join('|');
}

/**
 * A brand-new sync setup and a user upgrading from a build that predates the last-selection
 * tracking key both read back `null` for `storedIdsKey` - tell them apart via the hash map: if it
 * already has entries, a sync ran before under the old code with whatever selection produced
 * them, so trust that baseline instead of forcing one skipped run before deletions can be detected.
 */
export function isCalendarSelectionUnchanged(
  storedIdsKey: string | null,
  currentIdsKey: string,
  hasPriorHashes: boolean
): boolean {
  return storedIdsKey === null ? hasPriorHashes : storedIdsKey === currentIdsKey;
}

/**
 * Decides create/update/delete actions plus the hash map to persist assuming every action
 * succeeds. The caller must patch `nextHashes` for any action it fails to execute: on a failed
 * create/update, restore the previous hash (or drop the key if there wasn't one) so it's retried
 * next run; on a failed delete, restore the previous hash the same way. Both are `nextHashes[id] =
 * prevHashes[id]` (or `delete nextHashes[id]` when there is no previous hash) - see calendarSync.ts.
 */
export function planCalendarSync(
  deviceEvents: DeviceEvent[],
  memoEventsByDeviceId: Map<string, { id: string }>,
  prevHashes: Record<string, string>,
  selectionUnchanged: boolean
): { nextHashes: Record<string, string>; actions: SyncAction[] } {
  const nextHashes: Record<string, string> = {};
  const actions: SyncAction[] = [];

  for (const de of deviceEvents) {
    const hash = hashDeviceEvent({
      title: de.title || 'Untitled',
      location: de.location || '',
      notes: de.notes || '',
      startDate: de.startDate,
      endDate: de.endDate,
    });
    nextHashes[de.id] = hash;
    if (prevHashes[de.id] === hash) continue; // unchanged since last sync

    const match = memoEventsByDeviceId.get(de.id);
    const payload: EventPayload = {
      title: de.title || 'Untitled',
      description: de.notes || '',
      location: de.location || '',
      start_time: new Date(de.startDate).toISOString(),
      end_time: new Date(de.endDate).toISOString(),
    };
    if (match) {
      // Deliberately not sending reminder_minutes/linked_note_ids, so a user's MemoPad-side
      // customizations on this event survive a resync.
      actions.push({ kind: 'update', memoId: match.id, deviceId: de.id, payload });
    } else {
      actions.push({
        kind: 'create',
        deviceId: de.id,
        payload: { ...payload, linked_note_ids: [], reminder_minutes: null, device_calendar_event_id: de.id },
      });
    }
  }

  // Device events that disappeared since last sync: delete their MemoPad copy, but only when both
  // safety conditions hold (unchanged calendar selection, non-empty fetch) - otherwise just let the
  // hash map re-baseline from this run's results, so a real deletion is still caught on a later,
  // safe-to-act-on run. Assumed-successful deletes are simply absent from `nextHashes` (the caller
  // adds the entry back on failure, per this function's doc comment).
  if (selectionUnchanged && deviceEvents.length > 0) {
    for (const deviceId of Object.keys(prevHashes)) {
      if (deviceId in nextHashes) continue; // still present at the source
      const match = memoEventsByDeviceId.get(deviceId);
      if (!match) continue; // no MemoPad copy (already deleted, or never matched)
      actions.push({ kind: 'delete', memoId: match.id, deviceId });
    }
  }

  return { nextHashes, actions };
}
