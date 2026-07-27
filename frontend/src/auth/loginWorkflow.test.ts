/**
 * Unit tests for the post-login sequencing/branching logic. Framework-free:
 *   node --import ../crypto/_ts-resolver.mjs src/auth/loginWorkflow.test.ts
 */
import { runLoginWorkflow, type LoginWorkflowDeps } from './loginWorkflow.ts';
import type { User } from './types/auth.types.ts';

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, detail); }
}

function mkUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1', email: 'a@b.com', name: 'Alice', email_verified: true,
    created_at: '2026-01-01T00:00:00.000Z', enc_version: null,
    ...overrides,
  };
}

function mkDeps(overrides: Partial<LoginWorkflowDeps> = {}): { deps: LoginWorkflowDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: LoginWorkflowDeps = {
    e2eeKeysEnabled: true,
    bootstrapKeyOnLogin: async () => { calls.push('bootstrap'); return { status: 'unlocked' }; },
    // A real setTimeout delay (not just an unawaited microtask) so the "runLoginWorkflow
    // resolves without waiting for background work" assertion below is actually meaningful -
    // a synchronously-resolving mock would record its call before runLoginWorkflow's own
    // `return` runs too, which would pass that assertion for the wrong reason.
    fullSync: async () => { await new Promise((r) => setTimeout(r, 5)); calls.push('fullSync'); },
    migrateNotesToEncrypted: async () => { calls.push('migrateNotes'); return { status: 'skipped', reason: 'disabled' }; },
    migrateEventsToEncrypted: async () => { calls.push('migrateEvents'); return { status: 'skipped', reason: 'disabled' }; },
    getMe: async () => { calls.push('getMe'); return mkUser(); },
    pushBackPlaintextName: async () => { calls.push('pushBack'); },
    requestCalendarSyncPermission: async () => { calls.push('calendarPermission'); },
    onSyncReadyChange: () => { calls.push('syncReady'); },
    onUserRefetched: () => { calls.push('userRefetched'); },
    warn: () => { calls.push('warn'); },
    ...overrides,
  };
  return { deps, calls };
}

// Waits a macrotask so the fire-and-forget background work (kicked off without being awaited,
// same as the original AuthContext.tsx code) has a chance to run before assertions.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

async function main() {
  console.log('runLoginWorkflow - resolves as soon as bootstrap completes, not the full background work:');
  {
    const { deps, calls } = mkDeps();
    const result = await runLoginWorkflow('pw', mkUser(), deps);
    ok('bootstrap awaited before resolving', calls.includes('bootstrap'));
    ok('calendar permission requested', calls.includes('calendarPermission'));
    ok('resolves before background sync starts', !calls.includes('fullSync'), calls.join(','));
    ok('bootstrap result returned', result.bootstrap?.status === 'unlocked');
    ok('no pending password on a clean unlock', result.pendingPassword === null);
    await flush();
    ok('background sync ran after flush', calls.includes('fullSync'));
    ok('sync-ready signaled', calls.includes('syncReady'));
  }

  console.log('runLoginWorkflow - e2eeKeysEnabled=false skips bootstrap and migration entirely:');
  {
    const { deps, calls } = mkDeps({ e2eeKeysEnabled: false });
    const result = await runLoginWorkflow('pw', mkUser(), deps);
    await flush();
    ok('bootstrap never called', !calls.includes('bootstrap'));
    ok('bootstrap result is null', result.bootstrap === null);
    ok('migration never called', !calls.includes('migrateNotes') && !calls.includes('migrateEvents'));
    ok('sync still runs regardless of the E2EE flag', calls.includes('fullSync'));
  }

  console.log('runLoginWorkflow - needs_recovery: password held, migration skipped:');
  {
    const { deps, calls } = mkDeps({
      bootstrapKeyOnLogin: async () => ({ status: 'needs_recovery' }),
    });
    const result = await runLoginWorkflow('pw', mkUser(), deps);
    ok('pendingPassword set to the login password', result.pendingPassword === 'pw');
    await flush();
    ok('migration skipped when recovery is pending', !calls.includes('migrateNotes') && !calls.includes('migrateEvents'));
  }

  console.log('runLoginWorkflow - status "created": migration still runs (recovery not pending):');
  {
    const { deps, calls } = mkDeps({
      bootstrapKeyOnLogin: async () => ({ status: 'created', recoveryCode: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF' }),
    });
    const result = await runLoginWorkflow('pw', mkUser(), deps);
    ok('pendingPassword stays null', result.pendingPassword === null);
    ok('recovery code surfaced on the result', result.bootstrap?.status === 'created');
    await flush();
    ok('migration runs for a freshly-created escrow', calls.includes('migrateNotes') && calls.includes('migrateEvents'));
  }

  console.log('runLoginWorkflow - bootstrap throws: login still proceeds, background work still runs:');
  {
    const { deps, calls } = mkDeps({
      bootstrapKeyOnLogin: async () => { throw new Error('network down'); },
    });
    const result = await runLoginWorkflow('pw', mkUser(), deps);
    ok('bootstrap failure does not throw out of runLoginWorkflow', result.bootstrap === null);
    ok('failure warned, not swallowed silently', calls.includes('warn'));
    await flush();
    ok('background sync still kicks off after a bootstrap failure', calls.includes('fullSync'));
  }

  console.log('runLoginWorkflow - enc_version user: re-fetches via getMe before push-back:');
  {
    const { deps, calls } = mkDeps();
    await runLoginWorkflow('pw', mkUser({ enc_version: 1 }), deps);
    await flush();
    ok('getMe called to refresh a possibly-still-ciphertext user', calls.includes('getMe'));
    ok('userRefetched reported to the caller', calls.includes('userRefetched'));
    const pushBackIndex = calls.indexOf('pushBack');
    const getMeIndex = calls.indexOf('getMe');
    ok('push-back happens after the re-fetch, not before', getMeIndex < pushBackIndex, calls.join(','));
  }

  console.log('runLoginWorkflow - enc_version user, getMe fails: push-back skipped rather than risking stale ciphertext:');
  {
    const { deps, calls } = mkDeps({
      getMe: async () => { calls.push('getMe'); throw new Error('network down'); },
      pushBackPlaintextName: async (user) => { calls.push(user === null ? 'pushBack:null' : 'pushBack:user'); },
    });
    await runLoginWorkflow('pw', mkUser({ enc_version: 1 }), deps);
    await flush();
    ok('push-back called with null, not the stale object', calls.includes('pushBack:null'), calls.join(','));
  }

  console.log('runLoginWorkflow - plaintext user (no enc_version): push-back runs without a getMe re-fetch:');
  {
    const { deps, calls } = mkDeps();
    await runLoginWorkflow('pw', mkUser({ enc_version: null }), deps);
    await flush();
    ok('no re-fetch needed for an already-plaintext user', !calls.includes('getMe'));
    ok('push-back still runs (no-op guard lives inside pushBackPlaintextName itself)', calls.includes('pushBack'));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
