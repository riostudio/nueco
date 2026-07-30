/**
 * The post-login sequencing/branching business logic, extracted out of AuthContext.tsx (a
 * React provider) so it can be exercised without mounting a component tree. Deliberately takes
 * every side-effecting operation as an injected dependency rather than importing
 * crypto/keySession.ts, offlineSync.ts, etc. directly - this file itself stays framework/infra
 * free (no react/react-native/expo-* imports), per CLAUDE.md's Clean Architecture rules.
 *
 * What this owns: the ORDER things happen in and WHY (E2EE key bootstrap must be awaited
 * before anything that needs to decrypt notes; sync/migration/name-push-back run in the
 * background so login() returns immediately; migration is skipped when recovery is pending).
 * What it does NOT own: how each step is actually performed - that's each injected dep's job.
 */
import type { BootstrapResult } from '../crypto/keySession';
import type { MigrationResult } from '../crypto/noteMigration';
import type { EventMigrationResult } from '../crypto/eventMigration';
import type { User } from './types/auth.types';

export type LoginWorkflowDeps = {
  /** crypto/flags.ts's E2EE_KEYS_ENABLED, injected rather than imported directly - this file
   * has zero react/react-native/expo-* imports, transitive or otherwise, so it's plain-Node
   * testable with no Expo runtime shimming required. */
  e2eeKeysEnabled: boolean;
  bootstrapKeyOnLogin: (password: string) => Promise<BootstrapResult>;
  fullSync: (opts: { force?: boolean }) => Promise<void>;
  migrateNotesToEncrypted: (userId: string | undefined) => Promise<MigrationResult>;
  migrateEventsToEncrypted: (userId: string | undefined) => Promise<EventMigrationResult>;
  getMe: () => Promise<User>;
  pushBackPlaintextName: (user: User | null | undefined) => Promise<void>;
  requestCalendarSyncPermission: () => Promise<void>;
  onSyncReadyChange: (ready: boolean) => void;
  onUserRefetched: (user: User) => void;
  warn: (message: string, err: unknown) => void;
};

export type LoginWorkflowResult = {
  /** E2EE key-bootstrap outcome (null when E2EE keys are disabled). */
  bootstrap: BootstrapResult | null;
  /** Set when bootstrap came back `needs_recovery` - the caller should hold this password in
   * memory to complete a later recoverKey() call; never persisted here. */
  pendingPassword: string | null;
};

/**
 * Runs the E2EE key bootstrap (awaited - needed to decrypt notes) and kicks off the background
 * post-login work (full sync, gated migration, account-name push-back) WITHOUT awaiting it, so
 * this resolves as soon as the key bootstrap is done - matching login()'s original behavior of
 * returning immediately so the UI isn't blocked on the network.
 */
export async function runLoginWorkflow(
  password: string,
  user: User,
  deps: LoginWorkflowDeps,
): Promise<LoginWorkflowResult> {
  // Front-loads the calendar permission prompt right after login instead of waiting for the
  // user to first create/edit an event - so event-editor's device-calendar write and Nueco's
  // own sync queue both have access from the start. Not awaited: irrelevant to bootstrap/sync
  // ordering, and safe to call on every login (a no-op UI-wise if already granted/denied).
  deps.requestCalendarSyncPermission();

  // E2EE key bootstrap (Stage 3): establish the DEK in the device keystore now that we have
  // both a session and the password. Gated by feature flag.
  let bootstrap: BootstrapResult | null = null;
  let pendingPassword: string | null = null;
  if (deps.e2eeKeysEnabled) {
    try {
      bootstrap = await deps.bootstrapKeyOnLogin(password);
      if (bootstrap.status === 'needs_recovery') {
        // Hold the new password to complete the recovery re-wrap.
        pendingPassword = password;
      }
    } catch (e) {
      // Don't block login on a key-bootstrap failure (e.g. transient network); it will be
      // retried on the next login. Notes aren't encrypted yet (Stage 4).
      deps.warn('E2EE key bootstrap failed:', e);
    }
  }

  // Deliberately not awaited: login() returns as soon as this function resolves (right after
  // key bootstrap above), and the background work continues independently.
  runBackgroundPostLoginWork(user, bootstrap, deps);

  return { bootstrap, pendingPassword };
}

async function runBackgroundPostLoginWork(
  user: User,
  bootstrap: BootstrapResult | null,
  deps: LoginWorkflowDeps,
): Promise<void> {
  try {
    await deps.fullSync({ force: true });
  } catch (e) {
    deps.warn('Post-login sync failed:', e);
  } finally {
    // Signal that sync is complete so the notes screen can reload from AsyncStorage.
    deps.onSyncReadyChange(true);
  }

  // One-time eager migration of legacy plaintext notes/events -> ciphertext (Stage 4/5). Gated
  // OFF by default (no-op unless explicitly enabled + an Atlas snapshot); safe to run after
  // sync. Skipped when recovery is pending - the DEK isn't actually available yet in that case.
  if (deps.e2eeKeysEnabled && bootstrap?.status !== 'needs_recovery') {
    try {
      const m = await deps.migrateNotesToEncrypted(user.id);
      if (m.status === 'done') {
        console.log(`E2EE migration: ${m.migrated}/${m.total} notes encrypted, ${m.failed} failed`);
      }
    } catch (e) {
      deps.warn('E2EE note migration failed (will retry next login):', e);
    }
    try {
      const m = await deps.migrateEventsToEncrypted(user.id);
      if (m.status === 'done') {
        console.log(`E2EE migration: ${m.migrated}/${m.total} events encrypted, ${m.failed} failed`);
      }
    } catch (e) {
      deps.warn('E2EE event migration failed (will retry next login):', e);
    }
  }

  // `user` was decrypted back before bootstrapKeyOnLogin above had loaded a DEK - on a fresh
  // device (empty SecureStore) that decrypt is a no-op, so `user.name` can still be ciphertext
  // here even though pushBackPlaintextName's own guards all pass: they check that a DEK exists
  // NOW, not that this specific object was actually decrypted with it. Pushing that stale
  // object back would permanently bake the ciphertext in as the "plaintext" name. Re-fetch with
  // the DEK now in place instead, and report the refreshed user so the caller's UI doesn't show
  // ciphertext in the meantime.
  let userForPushBack: User | null = user;
  if (deps.e2eeKeysEnabled && user.enc_version) {
    try {
      const fresh = await deps.getMe();
      userForPushBack = fresh;
      deps.onUserRefetched(fresh);
    } catch (e) {
      deps.warn('Post-bootstrap user refresh failed (name push-back skipped):', e);
      userForPushBack = null; // don't risk pushing back a possibly-still-stale name
    }
  }
  await deps.pushBackPlaintextName(userForPushBack);
}
