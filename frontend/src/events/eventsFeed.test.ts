/**
 * Unit tests for the shared focus-load policy. Runnable without a framework:
 *   node --import ./src/crypto/_ts-resolver.mjs src/events/eventsFeed.test.ts
 *
 * The throttle is the risky half: too aggressive and a real edit made on another device stops
 * arriving, which is worse than the lag it was added to fix. The force carve-out is what keeps
 * pull-to-refresh honest.
 */
import { shouldFocusSync, eventsSignature, _resetFocusSyncClock, FOCUS_SYNC_MIN_MS } from './eventsFeed.ts';

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name); }
}

console.log('events feed');

// --- throttle ---
_resetFocusSyncClock();
const t0 = 1_000_000;
ok('first focus syncs', shouldFocusSync(false, t0) === true);
ok('immediate second focus is skipped', shouldFocusSync(false, t0 + 1) === false);
ok('still skipped just inside the window', shouldFocusSync(false, t0 + FOCUS_SYNC_MIN_MS - 1) === false);
ok('syncs again once the window passes', shouldFocusSync(false, t0 + FOCUS_SYNC_MIN_MS) === true);

// force must never be swallowed - it's an explicit user gesture
_resetFocusSyncClock();
ok('force syncs even on a cold clock', shouldFocusSync(true, t0) === true);
ok('force syncs again immediately', shouldFocusSync(true, t0 + 1) === true);
ok('force resets the window for later focuses', shouldFocusSync(false, t0 + 2) === false);

// The clock is shared, which is the whole point: bouncing Calendar <-> Events must not double-sync.
_resetFocusSyncClock();
ok('calendar focus syncs', shouldFocusSync(false, t0) === true);
ok('events focus right after does not', shouldFocusSync(false, t0 + 50) === false);

// --- signature ---
const a = [{ id: '1', updated_at: 'x' }, { id: '2', updated_at: 'y' }];
ok('same content, same signature', eventsSignature(a) === eventsSignature([...a]));
ok('an edit moves the signature',
  eventsSignature(a) !== eventsSignature([{ id: '1', updated_at: 'x' }, { id: '2', updated_at: 'z' }]));
ok('a deletion moves the signature', eventsSignature(a) !== eventsSignature([a[0]]));
ok('an addition moves the signature',
  eventsSignature(a) !== eventsSignature([...a, { id: '3', updated_at: 'q' }]));
ok('reordering moves the signature', eventsSignature(a) !== eventsSignature([a[1], a[0]]));
ok('empty list is stable', eventsSignature([]) === eventsSignature([]));
// Length prefix guards the case where concatenation could otherwise collide.
ok('missing fields do not collide with a real id',
  eventsSignature([{ id: '1:x' }]) !== eventsSignature([{ id: '1', updated_at: 'x' }]));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
