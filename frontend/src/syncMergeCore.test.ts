/**
 * Unit tests for the fullSync reconciliation rules. Framework-free:
 *   node --import ./src/crypto/_ts-resolver.mjs src/syncMergeCore.test.ts
 *
 * The cases that matter most are the ones about ABSENCE from a server pull, since reading absence
 * as "deleted on the server" is what used to wipe every note past the first page off the device.
 */
import {
  absenceMeansDeleted,
  isNewerTimestamp,
  mergeRecords,
  recordTimestamp,
  type MergeableRecord,
} from './syncMergeCore';

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, detail); }
}

interface TestRecord extends MergeableRecord {
  title?: string;
  local_notification_id?: string | null;
}

function rec(id: string, overrides: Partial<TestRecord> = {}): TestRecord {
  return {
    id,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    _isLocal: false,
    ...overrides,
  };
}

const PULL_STARTED_AT = '2026-08-01T12:00:00.000Z';
const BEFORE_PULL = '2026-08-01T11:00:00.000Z';
const AFTER_PULL = '2026-08-01T13:00:00.000Z';

function byId(records: TestRecord[]): Map<string, TestRecord> {
  return new Map(records.map((r) => [r.id, r]));
}

function main() {
  console.log('recordTimestamp:');
  {
    ok('prefers updated_at',
      recordTimestamp(rec('a', { created_at: BEFORE_PULL, updated_at: AFTER_PULL })) === AFTER_PULL);
    ok('falls back to created_at when updated_at is absent (legacy local event)',
      recordTimestamp({ id: 'a', created_at: BEFORE_PULL }) === BEFORE_PULL);
    ok('falls back to created_at when updated_at is null (backend legacy row)',
      recordTimestamp({ id: 'a', created_at: BEFORE_PULL, updated_at: null }) === BEFORE_PULL);
    ok('empty string when the record carries no timestamp at all',
      recordTimestamp({ id: 'a', created_at: '' }) === '');
  }

  console.log('isNewerTimestamp:');
  {
    ok('later beats earlier', isNewerTimestamp(AFTER_PULL, BEFORE_PULL) === true);
    ok('earlier loses to later', isNewerTimestamp(BEFORE_PULL, AFTER_PULL) === false);
    ok('equal is not newer (server wins ties)', isNewerTimestamp(AFTER_PULL, AFTER_PULL) === false);
    ok('compares instants, not strings (+10:00 offset is earlier than the same wall clock in UTC)',
      isNewerTimestamp('2026-08-01T13:00:00+10:00', '2026-08-01T13:00:00Z') === false);
    ok('an unreadable left side cannot win', isNewerTimestamp('not-a-date', BEFORE_PULL) === false);
    ok('a readable left side beats an unreadable right side',
      isNewerTimestamp(BEFORE_PULL, 'not-a-date') === true);
    ok('two unreadable sides are not newer', isNewerTimestamp('', '') === false);
  }

  console.log('mergeRecords - server records:');
  {
    const merged = mergeRecords<TestRecord>({
      server: [rec('s1', { title: 'from server' })],
      local: [],
      serverPullComplete: true,
      pullStartedAt: PULL_STARTED_AT,
    });
    ok('a server record the device has never seen is added', merged.length === 1 && merged[0].id === 's1');
    ok('and is marked as synced', merged[0]._isLocal === false);
  }

  console.log('mergeRecords - both sides have the record:');
  {
    const merged = mergeRecords<TestRecord>({
      server: [rec('x', { title: 'server copy', updated_at: AFTER_PULL })],
      local: [rec('x', { title: 'local copy', updated_at: BEFORE_PULL })],
      serverPullComplete: true,
      pullStartedAt: PULL_STARTED_AT,
    });
    ok('the newer server copy wins', merged.length === 1 && merged[0].title === 'server copy',
      JSON.stringify(merged));
  }
  {
    const merged = mergeRecords<TestRecord>({
      server: [rec('x', { title: 'server copy', updated_at: BEFORE_PULL })],
      local: [rec('x', { title: 'local copy', updated_at: AFTER_PULL })],
      serverPullComplete: true,
      pullStartedAt: PULL_STARTED_AT,
    });
    ok('a newer local edit survives the pull (its push is still in flight)',
      merged.length === 1 && merged[0].title === 'local copy', JSON.stringify(merged));
  }
  {
    const merged = mergeRecords<TestRecord>({
      server: [rec('x', { title: 'server copy' })],
      local: [rec('x', { title: 'local copy' })],
      serverPullComplete: true,
      pullStartedAt: PULL_STARTED_AT,
    });
    ok('identical timestamps resolve to the server copy',
      merged.length === 1 && merged[0].title === 'server copy', JSON.stringify(merged));
  }
  {
    // Events written before the type carried updated_at compare on created_at alone.
    const merged = mergeRecords<TestRecord>({
      server: [{ id: 'x', created_at: BEFORE_PULL, title: 'server legacy' }],
      local: [{ id: 'x', created_at: AFTER_PULL, title: 'local legacy' }],
      serverPullComplete: true,
      pullStartedAt: PULL_STARTED_AT,
    });
    ok('legacy records with no updated_at still compare newest-wins',
      merged.length === 1 && merged[0].title === 'local legacy', JSON.stringify(merged));
  }

  console.log('mergeRecords - local-only and pending-delete records:');
  {
    const merged = mergeRecords<TestRecord>({
      server: [rec('s1')],
      local: [rec('offline-1', { _isLocal: true, title: 'written offline' })],
      serverPullComplete: true,
      pullStartedAt: PULL_STARTED_AT,
    });
    ok('a never-uploaded record survives even a complete pull that omits it',
      byId(merged).has('offline-1'), JSON.stringify(merged));
    ok('and keeps its local flag so the queue still pushes it',
      byId(merged).get('offline-1')?._isLocal === true);
  }
  {
    const merged = mergeRecords<TestRecord>({
      server: [rec('x', { title: 'still on server' })],
      local: [rec('x', { _pendingDelete: true })],
      serverPullComplete: true,
      pullStartedAt: PULL_STARTED_AT,
    });
    ok('a record whose delete has not landed yet is not resurrected by the pull that still returns it',
      merged.length === 1 && merged[0]._pendingDelete === true, JSON.stringify(merged));
  }
  {
    const merged = mergeRecords<TestRecord>({
      server: [],
      local: [rec('x', { _pendingDelete: true })],
      serverPullComplete: true,
      pullStartedAt: PULL_STARTED_AT,
    });
    ok('the tombstone is cleared once the server confirms the record is gone',
      merged.length === 0, JSON.stringify(merged));
  }

  console.log('mergeRecords - absence from the pull (the data-loss case):');
  {
    const merged = mergeRecords<TestRecord>({
      server: [],
      local: [rec('page-2-note', { updated_at: BEFORE_PULL })],
      serverPullComplete: false,
      pullStartedAt: PULL_STARTED_AT,
    });
    ok('an incomplete pull never deletes: a record it did not reach is kept',
      merged.length === 1 && merged[0].id === 'page-2-note', JSON.stringify(merged));
  }
  {
    const merged = mergeRecords<TestRecord>({
      server: [],
      local: [rec('deleted-elsewhere', { updated_at: BEFORE_PULL })],
      serverPullComplete: true,
      pullStartedAt: PULL_STARTED_AT,
    });
    ok('a complete pull does delete: a record the server no longer has is dropped',
      merged.length === 0, JSON.stringify(merged));
  }
  {
    const merged = mergeRecords<TestRecord>({
      server: [],
      local: [rec('edited-mid-pull', { updated_at: AFTER_PULL })],
      serverPullComplete: true,
      pullStartedAt: PULL_STARTED_AT,
    });
    ok('a record edited after the pull began is kept - it could have re-sorted past a read page',
      merged.length === 1 && merged[0].id === 'edited-mid-pull', JSON.stringify(merged));
  }

  console.log('mergeRecords - device-only fields:');
  {
    const merged = mergeRecords<TestRecord>({
      server: [rec('x', { title: 'server copy' })],
      local: [rec('x', { local_notification_id: 'os-handle-42' })],
      serverPullComplete: true,
      pullStartedAt: PULL_STARTED_AT,
      adoptLocalFields: (serverRecord, previousLocal) => ({
        ...serverRecord,
        local_notification_id: previousLocal?.local_notification_id ?? null,
      }),
    });
    ok('the scheduled-notification handle survives a pull that overwrites the record',
      merged[0].local_notification_id === 'os-handle-42', JSON.stringify(merged));
  }
  {
    const merged = mergeRecords<TestRecord>({
      server: [rec('brand-new')],
      local: [],
      serverPullComplete: true,
      pullStartedAt: PULL_STARTED_AT,
      adoptLocalFields: (serverRecord, previousLocal) => ({
        ...serverRecord,
        local_notification_id: previousLocal?.local_notification_id ?? null,
      }),
    });
    ok('a record with no previous local copy adopts a null handle rather than throwing',
      merged.length === 1 && merged[0].local_notification_id === null, JSON.stringify(merged));
  }

  console.log('mergeRecords - a realistic mixed pull:');
  {
    const merged = mergeRecords<TestRecord>({
      server: [
        rec('untouched'),
        rec('server-newer', { updated_at: AFTER_PULL, title: 'server copy' }),
        rec('new-on-server'),
      ],
      local: [
        rec('untouched'),
        rec('server-newer', { updated_at: BEFORE_PULL, title: 'local copy' }),
        rec('local-newer', { updated_at: AFTER_PULL, title: 'local copy' }),
        rec('offline-only', { _isLocal: true }),
        rec('being-deleted', { _pendingDelete: true }),
        rec('gone-from-server', { updated_at: BEFORE_PULL }),
      ],
      serverPullComplete: true,
      pullStartedAt: PULL_STARTED_AT,
    });
    const ids = merged.map((r) => r.id).sort();
    ok('every record appears exactly once', ids.length === new Set(ids).size, ids.join(','));
    ok('the surviving set is exactly the expected one',
      ids.join(',') === ['local-newer', 'new-on-server', 'offline-only', 'server-newer', 'untouched'].sort().join(','),
      ids.join(','));
    ok('server-newer resolved to the server copy',
      byId(merged).get('server-newer')?.title === 'server copy');
    ok('local-newer resolved to the local copy',
      byId(merged).get('local-newer')?.title === 'local copy');
  }
  {
    // `local-newer` above is a server record too; make sure a local win doesn't drop the server's
    // presence and let a later merge treat it as local-only.
    const merged = mergeRecords<TestRecord>({
      server: [rec('x', { updated_at: BEFORE_PULL })],
      local: [rec('x', { updated_at: AFTER_PULL })],
      serverPullComplete: true,
      pullStartedAt: PULL_STARTED_AT,
    });
    ok('a local win stays marked as synced', merged[0]._isLocal === false, JSON.stringify(merged));
  }

  console.log('absenceMeansDeleted:');
  {
    ok('incomplete pull -> never',
      absenceMeansDeleted(rec('a', { updated_at: BEFORE_PULL }), false, PULL_STARTED_AT) === false);
    ok('complete pull + record older than the pull -> yes',
      absenceMeansDeleted(rec('a', { updated_at: BEFORE_PULL }), true, PULL_STARTED_AT) === true);
    ok('complete pull + record written during the pull -> no',
      absenceMeansDeleted(rec('a', { updated_at: AFTER_PULL }), true, PULL_STARTED_AT) === false);
    ok('a record written exactly at the pull start is not treated as mid-pull',
      absenceMeansDeleted(rec('a', { updated_at: PULL_STARTED_AT }), true, PULL_STARTED_AT) === true);
    ok('an unreadable record timestamp does not block deletion on a complete pull',
      absenceMeansDeleted({ id: 'a', created_at: 'garbage' }, true, PULL_STARTED_AT) === true);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
