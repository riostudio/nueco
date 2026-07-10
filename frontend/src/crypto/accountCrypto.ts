/**
 * Account display-name encryption (Stage 5). Unlike notes/events, this is a single
 * field on a single document, so it doesn't need its own pure-core + device-wiring
 * pair - both directions live here.
 *
 * Name can't be encrypted at signup: there's no DEK yet (the DEK is created at first
 * login, see keySession.ts/E2EE-DESIGN.md §5). So a freshly signed-up user's name is
 * plaintext until their first login, at which point `AuthContext.tsx` encrypts it and
 * pushes it via `authApi.updateName` - see that file for the orchestration. This
 * module only holds the pure encrypt/decrypt.
 */
import { encryptString, decryptString, ENC_VERSION } from './e2ee';
import { loadDek } from './keystore';

/** Shown in place of a name we hold ciphertext for but cannot decrypt (wrong key /
 * tamper / corruption). Never crash account/profile UI over this. */
export const UNDECRYPTABLE_PLACEHOLDER = '⚠️ Unable to decrypt';

export interface EncryptableAccount {
  name: string;
  enc_version?: number | null;
}

/** Encrypt `name` under `dek` for the one-time push after key bootstrap. */
export function encryptAccountName(name: string, dek: Uint8Array): { name: string; enc_version: number } {
  return { name: encryptString(name, dek), enc_version: ENC_VERSION };
}

/**
 * Decrypt the account name from a server response. Plaintext (enc_version !=
 * ENC_VERSION) passes straight through. No DEK available -> returned untouched
 * (ciphertext renders as-is rather than crashing); this only happens if the flag is
 * on but the keystore is empty (an unexpected, transient state), same as notes/events.
 *
 * Deliberately does NOT clear `enc_version` to null the way notes/events do after
 * decrypting. Those get re-encrypted from scratch on every save, so nulling is safe
 * there. The account name has no such save cycle - the only write path is the explicit,
 * one-time `authApi.updateName` push from the key-bootstrap flow in AuthContext.tsx,
 * which needs to know whether the server copy is *already* encrypted to decide whether
 * to push at all. Keeping `enc_version` truthful after decrypt is what makes that
 * decision possible.
 */
export async function decryptAccountFromServer<T extends EncryptableAccount>(user: T): Promise<T> {
  if (user.enc_version !== ENC_VERSION) return user;
  const dek = await loadDek();
  if (!dek) return user;
  let name: string;
  try {
    name = decryptString(user.name, dek);
  } catch {
    name = UNDECRYPTABLE_PLACEHOLDER;
  }
  return { ...user, name };
}
