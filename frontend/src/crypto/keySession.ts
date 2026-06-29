/**
 * Key-session orchestration (Stage 3): bootstrap the per-user DEK at login and
 * keep it in the device keystore. No note encryption happens here — that's Stage 4.
 *
 * Lifecycle:
 *  - First login / legacy user (no escrow): create DEK + recovery code, escrow it,
 *    store the DEK, and return the recovery code to show ONCE.
 *  - Normal login (escrow exists, password unwraps): load the DEK into SecureStore.
 *  - Login after an email-token password reset (escrow exists, but the password
 *    can no longer unwrap it): return `needs_recovery` so the UI can ask for the
 *    recovery code, then `recoverKeyWithCode` re-wraps under the new password.
 *  - Authenticated password change: re-wrap the in-device DEK under the new password.
 *  - Logout: clear the DEK from the device.
 */
import {
  createEscrow,
  unlockWithPassword,
  unlockWithRecovery,
  rewrapForNewPassword,
  rewrapWithDek,
} from './e2ee';
import { getEscrow, putEscrow } from './escrowApi';
import { storeDek, clearDek, loadDek } from './keystore';

export type BootstrapResult =
  | { status: 'unlocked' }                        // existing escrow, password worked
  | { status: 'created'; recoveryCode: string }   // new escrow — show the code once
  | { status: 'needs_recovery' };                 // password no longer unwraps (post-reset)

/**
 * Run at login (password in hand). Establishes the DEK in SecureStore.
 * Throws only on network/server errors; a wrong-but-valid password that simply
 * can't unwrap the escrow yields `needs_recovery`, not a throw.
 */
export async function bootstrapKeyOnLogin(password: string): Promise<BootstrapResult> {
  const escrow = await getEscrow();

  if (!escrow) {
    const { dek, recoveryCode, bundle } = createEscrow(password);
    await putEscrow(bundle);
    await storeDek(dek);
    return { status: 'created', recoveryCode };
  }

  try {
    const dek = unlockWithPassword(escrow, password);
    await storeDek(dek);
    return { status: 'unlocked' };
  } catch {
    // Auth succeeded but the escrow's password-wrap is stale (e.g. password was
    // reset via email, which can't re-wrap server-side). Recovery code required.
    return { status: 'needs_recovery' };
  }
}

/**
 * Post-reset recovery: unwrap the DEK with the recovery code, re-wrap it under the
 * (new) password, persist the updated escrow, and store the DEK. Throws on a bad code.
 */
export async function recoverKeyWithCode(recoveryCode: string, newPassword: string): Promise<void> {
  const escrow = await getEscrow();
  if (!escrow) throw new Error('No key escrow to recover');
  const dek = unlockWithRecovery(escrow, recoveryCode); // throws on a wrong code
  const updated = rewrapForNewPassword(escrow, recoveryCode, newPassword);
  await putEscrow(updated);
  await storeDek(dek);
}

/**
 * Authenticated password change: re-wrap the in-device DEK under the new password.
 * No-op if the key wasn't bootstrapped (no escrow or no local DEK).
 */
export async function rewrapDekForNewPassword(newPassword: string): Promise<void> {
  const [escrow, dek] = await Promise.all([getEscrow(), loadDek()]);
  if (!escrow || !dek) return;
  await putEscrow(rewrapWithDek(escrow, dek, newPassword));
}

export async function clearKeyOnLogout(): Promise<void> {
  await clearDek();
}
