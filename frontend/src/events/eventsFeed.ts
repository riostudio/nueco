/**
 * Shared focus-load policy for the two screens that render the same event list.
 *
 * WHY THIS EXISTS
 * (tabs)/calendar.tsx and (tabs)/events.tsx both ran an identical `useFocusEffect(loadEvents)`:
 * read the local store, setEvents, run a full network sync, read again, setEvents again. Two
 * problems compounded on every single tab switch.
 *
 * 1. getLocalEvents() is cached, but it hands back a fresh array each call (`[...events]`). A new
 *    reference always fails React's identity check, so both setEvents calls re-rendered the whole
 *    list even when not one field had changed. Switching Notes -> Calendar -> Events paid for four
 *    full list renders of data that was already on screen.
 * 2. fullSync() fired on every focus. Flicking between the two tabs is a normal thing to do and it
 *    put a network round-trip behind each flick.
 *
 * Both screens now share the clock below, so bouncing between Calendar and Events doesn't sync
 * twice either - the throttle is per-app, not per-screen.
 *
 * Framework-agnostic (no react/react-native imports) per CLAUDE.md, so it's unit-testable in plain
 * node.
 */

/** Minimum spacing between focus-triggered network syncs, across all screens. */
export const FOCUS_SYNC_MIN_MS = 20_000;

let lastFocusSyncAt = 0;

/**
 * True when a focus-triggered sync should actually hit the network.
 *
 * `force` (pull-to-refresh) always wins: an explicit user gesture must never be silently swallowed
 * by the throttle, or the app looks broken in exactly the moment someone is asking it to catch up.
 */
export function shouldFocusSync(force?: boolean, now: number = Date.now()): boolean {
  if (force) {
    lastFocusSyncAt = now;
    return true;
  }
  if (now - lastFocusSyncAt < FOCUS_SYNC_MIN_MS) return false;
  lastFocusSyncAt = now;
  return true;
}

/** Test seam: reset the shared clock between cases. */
export function _resetFocusSyncClock(): void {
  lastFocusSyncAt = 0;
}

/**
 * Cheap content fingerprint for an event list.
 *
 * id + updated_at is enough: every write path stamps updated_at, so any edit that could change what
 * the list renders moves the signature. Deliberately not JSON.stringify of the whole list - that
 * walks every field of every event on each focus, which is the cost this is meant to avoid.
 */
export function eventsSignature(list: ReadonlyArray<{ id?: string; updated_at?: string }>): string {
  let sig = String(list.length);
  for (const e of list) sig += `|${e.id ?? ''}:${e.updated_at ?? ''}`;
  return sig;
}
