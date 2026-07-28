/**
 * In-process handoff for one or more event ids that were just created elsewhere (voice-event.tsx)
 * and need to be linked back to the note the user was dictating in. editor.tsx's existing
 * pendingLinkedEventId (singular, AsyncStorage-based) mechanism only carries one id - it was
 * built for event-editor.tsx's single "Schedule New Event" flow. A multi-event/itinerary voice
 * request can create several events at once, so this carries an array instead.
 *
 * A module singleton (not AsyncStorage) is enough - matches pendingVoiceEvents.ts/
 * pendingSketch.ts's reasoning: the JS runtime is continuous from voice-event.tsx's save through
 * to editor.tsx regaining focus via router.back().
 */
let pending: string[] | null = null;

export function setPendingLinkedEventIds(ids: string[]): void {
  pending = ids.length > 0 ? ids : null;
}

/** Return the staged ids and clear them (single consumer). */
export function takePendingLinkedEventIds(): string[] | null {
  const ids = pending;
  pending = null;
  return ids;
}
