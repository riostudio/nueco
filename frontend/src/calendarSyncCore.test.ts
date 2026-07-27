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

  console.log('planCalendarSync - new device event with no MemoPad match -> create:');
  {
    const de = mkDeviceEvent();
    const { actions, nextHashes } = planCalendarSync([de], new Map(), {}, true);
    ok('one create action', actions.length === 1 && actions[0].kind === 'create', JSON.stringify(actions));
    ok('create carries device_calendar_event_id', actions[0].kind === 'create' && actions[0].payload.device_calendar_event_id === 'dev-1');
    ok('hash recorded for the device event', nextHashes['dev-1'] === hashDeviceEvent({ title: 'Standup', location: '', notes: '', startDate: de.startDate, endDate: de.endDate }));
  }

  console.log('planCalendarSync - changed device event with a MemoPad match -> update:');
  {
    const de = mkDeviceEvent({ title: 'Standup (moved)' });
    const byDeviceId = new Map([['dev-1', { id: 'memo-1' }]]);
    const { actions } = planCalendarSync([de], byDeviceId, { 'dev-1': 'stale-hash' }, true);
    ok('one update action targeting the matched MemoPad id', actions.length === 1 && actions[0].kind === 'update' && actions[0].memoId === 'memo-1', JSON.stringify(actions));
  }

  console.log('planCalendarSync - unchanged hash -> no action:');
  {
    const de = mkDeviceEvent();
    const hash = hashDeviceEvent({ title: 'Standup', location: '', notes: '', startDate: de.startDate, endDate: de.endDate });
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
    const prevHashes = { 'dev-1': 'old-hash-1', 'dev-2': hashDeviceEvent({ title: 'Standup', location: '', notes: '', startDate: stillPresent.startDate, endDate: stillPresent.endDate }) };
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

  console.log('planCalendarSync - disappeared device event with no MemoPad match -> no action:');
  {
    const { actions } = planCalendarSync([], new Map(), { 'dev-1': 'old-hash' }, true);
    ok('nothing to delete when there was never a MemoPad copy', actions.length === 0, JSON.stringify(actions));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
