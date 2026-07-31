/**
 * Unit tests for calendarSync.ts's pure decision logic. Framework-free:
 *   node --import ./src/crypto/_ts-resolver.mjs src/calendarSyncCore.test.ts
 */
import { hashDeviceEvent, isCalendarSelectionUnchanged, planCalendarSync, type DeviceEvent } from './calendarSyncCore.ts';

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, detail); }
}

function mkDeviceEvent(overrides: Partial<DeviceEvent> = {}): DeviceEvent {
  return {
    id: 'dev-1',
    title: 'Standup',
    location: '',
    notes: '',
    startDate: '2026-07-13T09:00:00.000Z',
    endDate: '2026-07-13T09:30:00.000Z',
    allDay: false,
    ...overrides,
  };
}

function main() {
  console.log('isCalendarSelectionUnchanged:');
  {
    ok('null stored + no prior hashes -> unchanged is false (fresh setup)',
      isCalendarSelectionUnchanged(null, '["a"]', false) === false);
    ok('null stored + has prior hashes -> unchanged is true (pre-tracking upgrade)',
      isCalendarSelectionUnchanged(null, '["a"]', true) === true);
    ok('stored matches current -> true',
      isCalendarSelectionUnchanged('["a"]', '["a"]', true) === true);
    ok('stored differs from current -> false',
      isCalendarSelectionUnchanged('["a"]', '["b"]', true) === false);
  }

  console.log('planCalendarSync - new device event with no Nueco match -> create:');
  {
    const de = mkDeviceEvent();
    const { actions, nextHashes } = planCalendarSync([de], new Map(), {}, true);
    ok('one create action', actions.length === 1 && actions[0].kind === 'create', JSON.stringify(actions));
    ok('create carries device_calendar_event_id', actions[0].kind === 'create' && actions[0].payload.device_calendar_event_id === 'dev-1');
    ok('hash recorded for the device event', nextHashes['dev-1'] === hashDeviceEvent({ title: 'Standup', location: '', notes: '', startDate: de.startDate, endDate: de.endDate, allDay: false }));
  }

  console.log('planCalendarSync - changed device event with a Nueco match -> update:');
  {
    const de = mkDeviceEvent({ title: 'Standup (moved)' });
    const byDeviceId = new Map([['dev-1', { id: 'memo-1' }]]);
    const { actions } = planCalendarSync([de], byDeviceId, { 'dev-1': 'stale-hash' }, true);
    ok('one update action targeting the matched Nueco id', actions.length === 1 && actions[0].kind === 'update' && actions[0].memoId === 'memo-1', JSON.stringify(actions));
  }

  console.log('planCalendarSync - unchanged hash -> no action:');
  {
    const de = mkDeviceEvent();
    const hash = hashDeviceEvent({ title: 'Standup', location: '', notes: '', startDate: de.startDate, endDate: de.endDate, allDay: false });
    const byDeviceId = new Map([['dev-1', { id: 'memo-1' }]]);
    const { actions } = planCalendarSync([de], byDeviceId, { 'dev-1': hash }, true);
    ok('no actions when nothing changed', actions.length === 0, JSON.stringify(actions));
  }

  console.log('planCalendarSync - device event disappeared, selection unchanged, non-empty fetch -> delete:');
  {
    const stillPresent = mkDeviceEvent({ id: 'dev-2' });
    const byDeviceId = new Map([
      ['dev-1', { id: 'memo-1' }], // gone from deviceEvents below
      ['dev-2', { id: 'memo-2' }],
    ]);
    const prevHashes = { 'dev-1': 'old-hash-1', 'dev-2': hashDeviceEvent({ title: 'Standup', location: '', notes: '', startDate: stillPresent.startDate, endDate: stillPresent.endDate, allDay: false }) };
    const { actions } = planCalendarSync([stillPresent], byDeviceId, prevHashes, true);
    ok('deletes only the disappeared event', actions.length === 1 && actions[0].kind === 'delete' && actions[0].memoId === 'memo-1', JSON.stringify(actions));
  }

  console.log('planCalendarSync - safety check: selection changed -> no delete even if event disappeared:');
  {
    const byDeviceId = new Map([['dev-1', { id: 'memo-1' }]]);
    const { actions } = planCalendarSync([], byDeviceId, { 'dev-1': 'old-hash' }, false);
    ok('no delete when selectionUnchanged is false', actions.every((a) => a.kind !== 'delete'), JSON.stringify(actions));
  }

  console.log('planCalendarSync - safety check: empty device fetch -> no delete even with unchanged selection:');
  {
    const byDeviceId = new Map([['dev-1', { id: 'memo-1' }]]);
    const { actions } = planCalendarSync([], byDeviceId, { 'dev-1': 'old-hash' }, true);
    ok('no delete when deviceEvents is empty (guards a transient empty read)', actions.every((a) => a.kind !== 'delete'), JSON.stringify(actions));
  }

  console.log('planCalendarSync - disappeared device event with no Nueco match -> no action:');
  {
    const { actions } = planCalendarSync([], new Map(), { 'dev-1': 'old-hash' }, true);
    ok('nothing to delete when there was never a Nueco copy', actions.length === 0, JSON.stringify(actions));
  }

  // Both cases below run under TZ=Australia/Melbourne (a positive UTC offset, matching the bug
  // report this fix addresses) to prove the date extraction is immune to local timezone - a
  // regression here (e.g. someone swapping toDateOnly's UTC getters for local ones) would shift
  // the date on a positive-offset device too, not just a negative-offset one.
  const prevTz = process.env.TZ;
  process.env.TZ = 'Australia/Melbourne';
  try {
    console.log('planCalendarSync - all-day event from a positive-UTC-offset timezone -> date-only, no shift:');
    {
      // Device convention: all-day DTSTART/DTEND are UTC midnight of the intended date (28/29
      // Sep 2026), regardless of device timezone - exactly the "10:00 AM" evidence from the bug
      // report (28 Sep 2026 UTC midnight -> 10:00 AM AEST when wrongly rendered as an instant).
      const holiday = mkDeviceEvent({
        id: 'dev-holiday',
        title: 'Public Holiday',
        startDate: '2026-09-28T00:00:00.000Z',
        endDate: '2026-09-29T00:00:00.000Z',
        allDay: true,
      });
      const { actions } = planCalendarSync([holiday], new Map(), {}, true);
      const created = actions[0];
      ok('one create action', actions.length === 1 && created.kind === 'create', JSON.stringify(actions));
      ok('all_day flag set on the payload', created.kind === 'create' && created.payload.all_day === true);
      ok('start_time is the plain date, not shifted to 27 Sep', created.kind === 'create' && created.payload.start_time === '2026-09-28');
      ok('end_time is the plain date, not shifted', created.kind === 'create' && created.payload.end_time === '2026-09-29');
      ok('no time-of-day component leaked into either field',
        created.kind === 'create' && !created.payload.start_time.includes('T') && !created.payload.end_time.includes('T'));
    }

    console.log('planCalendarSync - all-day events spanning a DST transition -> both dates still exact:');
    {
      // Melbourne's AEDT (UTC+11) starts 4 Oct 2026 - one event just before the transition, one
      // just after. Both device-side UTC-midnight instants; date-only extraction must land on
      // the same calendar date either side of the transition, unlike the old instant-based
      // rendering (which is exactly why the bug report's "10:00 AM" became "11:00 AM" at the
      // DST boundary - this fix makes the boundary irrelevant instead of shifting the display).
      const beforeDst = mkDeviceEvent({
        id: 'dev-before-dst',
        title: 'Before DST',
        startDate: '2026-09-28T00:00:00.000Z',
        endDate: '2026-09-29T00:00:00.000Z',
        allDay: true,
      });
      const afterDst = mkDeviceEvent({
        id: 'dev-after-dst',
        title: 'After DST',
        startDate: '2026-10-05T00:00:00.000Z',
        endDate: '2026-10-06T00:00:00.000Z',
        allDay: true,
      });
      const { actions } = planCalendarSync([beforeDst, afterDst], new Map(), {}, true);
      const before = actions.find((a) => a.kind === 'create' && a.deviceId === 'dev-before-dst');
      const after = actions.find((a) => a.kind === 'create' && a.deviceId === 'dev-after-dst');
      ok('pre-DST event lands on 28 Sep, unaffected by the upcoming transition',
        before?.kind === 'create' && before.payload.start_time === '2026-09-28', JSON.stringify(before));
      ok('post-DST event lands on 5 Oct, unaffected by the just-passed transition',
        after?.kind === 'create' && after.payload.start_time === '2026-10-05', JSON.stringify(after));
    }
  } finally {
    if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
