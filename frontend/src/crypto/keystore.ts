/**
 * Device-local storage for the Data Encryption Key (DEK).
 *
 * The DEK lives in the OS keystore (Android Keystore / iOS Keychain) via
 * expo-secure-store — never in AsyncStorage, never sent to the server/analytics.
 * Stored base64-encoded. Web has no SecureStore, so E2EE is native-only for now
 * (web calls are no-ops and `loadDek` returns null).
 */
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { toB64, fromB64 } from './e2ee';

const DEK_KEY = 'e2ee_dek_v1';
const isWeb = Platform.OS === 'web';

export async function storeDek(dek: Uint8Array): Promise<void> {
  if (isWeb) return;
  await SecureStore.setItemAsync(DEK_KEY, toB64(dek));
}

export async function loadDek(): Promise<Uint8Array | null> {
  if (isWeb) return null;
  const b64 = await SecureStore.getItemAsync(DEK_KEY);
  return b64 ? fromB64(b64) : null;
}

export async function clearDek(): Promise<void> {
  if (isWeb) return;
  await SecureStore.deleteItemAsync(DEK_KEY);
}

export async function hasDek(): Promise<boolean> {
  return (await loadDek()) !== null;
}
