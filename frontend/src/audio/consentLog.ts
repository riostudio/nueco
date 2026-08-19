/**
 * Local-only attestation log for conversation-mode sessions (plan/11 "Logging").
 *
 * Stored on-device in AsyncStorage and NEVER sent to the server: it is a record for the user
 * (visible in settings/note details and included in exports), not telemetry.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ConsentRecord } from './conversation';

const CONSENT_LOG_KEY = 'conversation_consent_log';

export async function appendConsentRecord(record: ConsentRecord): Promise<void> {
  try {
    const existing = await getConsentRecords();
    await AsyncStorage.setItem(CONSENT_LOG_KEY, JSON.stringify([...existing, record]));
  } catch (e) {
    console.warn('Could not persist consent record:', e);
  }
}

export async function getConsentRecords(): Promise<ConsentRecord[]> {
  try {
    const raw = await AsyncStorage.getItem(CONSENT_LOG_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Running count shown in Settings as the visible consequence of each attestation (plan/11
 * anti-habituation: make the outcome visible, don't add friction). */
export async function confirmedSessionCount(): Promise<number> {
  const records = await getConsentRecords();
  return records.filter(r => r.choice === 'confirmed').length;
}
