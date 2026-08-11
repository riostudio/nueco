/**
 * Device-local storage for the Data Encryption Key (DEK).
 *
 * The DEK lives in the OS keystore (Android Keystore / iOS Keychain) via
 * expo-secure-store - never in AsyncStorage, never sent to the server/analytics.
 * Stored base64-encoded. Web has no SecureStore, so E2EE is native-only for now
 * (web calls are no-ops and `loadDek` returns null).
 */
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { toB64, fromB64 } from './e2ee';

const DEK_KEY = 'e2ee_dek_v1';
const isWeb = Platform.OS === 'web';

// In-process memo of the DEK. Every encrypt/decrypt boundary call (noteCrypto/eventCrypto/
// tripCrypto) starts with a loadDek(), so a single processSyncQueue pass or note save does one
// SecureStore round-trip PER item - and a SecureStore read is a native, keystore-backed
// operation, not a cheap map lookup. The key is already held in memory for the duration of every
// one of those calls, so memoizing it here changes nothing about its exposure; it just stops the
// same value being re-fetched from the OS keystore dozens of times on the interaction path.
// `undefined` = not yet read, `null` = read and genuinely absent.
let _dekCache: Uint8Array | null | undefined;

/** Drop the memo (sign-out, key rotation, recovery). Next loadDek() re-reads the keystore. */
export function invalidateDekCache(): void {
  _dekCache = undefined;
}

export async function storeDek(dek: Uint8Array): Promise<void> {
  if (isWeb) return;
  await SecureStore.setItemAsync(DEK_KEY, toB64(dek));
  _dekCache = dek;
}

export async function loadDek(): Promise<Uint8Array | null> {
  if (isWeb) return null;
  if (_dekCache !== undefined) return _dekCache;
  const b64 = await SecureStore.getItemAsync(DEK_KEY);
  _dekCache = b64 ? fromB64(b64) : null;
  return _dekCache;
}

export async function clearDek(): Promise<void> {
  if (isWeb) return;
  _dekCache = undefined;
  await SecureStore.deleteItemAsync(DEK_KEY);
}

export async function hasDek(): Promise<boolean> {
  return (await loadDek()) !== null;
}
