/**
 * Client for the server-side key escrow (`/api/crypto/wrapped-key`).
 *
 * The server stores only the opaque EscrowBundle (wrapped DEK blobs + salts +
 * KDF params). It never sees the DEK or note plaintext. GET returns 404 when the
 * user has no escrow yet (new or legacy user) - surfaced here as `null`.
 */
import { authStorage } from '../auth/storage/authStorage';
import { BACKEND_API_BASE_URL } from '../backendBaseUrl';
import type { EscrowBundle } from './e2ee';

async function authHeaders(): Promise<Record<string, string>> {
  const token = await authStorage.getAccessToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** Fetch the user's escrow bundle, or null if none exists (HTTP 404). */
export async function getEscrow(): Promise<EscrowBundle | null> {
  const res = await fetch(`${BACKEND_API_BASE_URL}/crypto/wrapped-key`, {
    headers: await authHeaders(),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to load key escrow (${res.status})`);
  return (await res.json()) as EscrowBundle;
}

/** Store/replace the user's escrow bundle (opaque to the server). */
export async function putEscrow(bundle: EscrowBundle): Promise<void> {
  const res = await fetch(`${BACKEND_API_BASE_URL}/crypto/wrapped-key`, {
    method: 'PUT',
    headers: await authHeaders(),
    body: JSON.stringify(bundle),
  });
  if (!res.ok) throw new Error(`Failed to store key escrow (${res.status})`);
}
