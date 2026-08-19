/**
 * google/auth.ts
 * Google OAuth (PKCE, authorization-code flow) for the client-side Google Calendar sync.
 *
 * The backend never talks to Google - tokens live ONLY on-device in SecureStore and are used by
 * calendarApi.ts to call the Calendar REST API directly. This mirrors the app's E2EE posture:
 * Nueco's server never holds a credential that could read the user's calendar.
 *
 * Flow: expo-auth-session opens the system browser (Chrome Custom Tab on Android) → user
 * consents → redirect back via the package-name scheme (com.riostudio.memopad:/oauth2redirect,
 * registered as an intent filter) with an authorization code → exchanged
 * here for access + refresh tokens (with the PKCE verifier) → persisted in SecureStore.
 * Silent refresh: getValidAccessToken() refreshes automatically shortly before expiry, so sync
 * paths (including the headless background task) never need to prompt.
 *
 * Prerequisite (owner-side, one-time): a Google Cloud project with the Calendar API enabled,
 * an OAuth consent screen with the calendar scope, and an Android OAuth client ID whose
 * package name + SHA-1 match this build. The client ID is baked in at build time via
 * GOOGLE_ANDROID_CLIENT_ID → app.config.js extra.googleAndroidClientId. Until it's set,
 * isGoogleConnectAvailable() returns false and the settings screen hides the feature.
 */
import Constants from 'expo-constants';
import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const TOKENS_KEY = 'google_oauth_tokens';

// Full read/write on the user's own calendars - required for two-way sync (creating, updating
// and deleting events, not just reading). openid/email only to show which account is connected.
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  // calendar.events doesn't cover the calendarList endpoint (listing the user's calendars);
  // readonly adds read on calendar metadata without widening event access to full `calendar`.
  'https://www.googleapis.com/auth/calendar.readonly',
  'openid',
  'email',
];

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
// Refresh when less than this much lifetime remains, so a sync burst can't outlive the token.
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms when accessToken expires. */
  expiresAt: number;
  /** Email of the connected Google account (for display only). */
  email: string | null;
}

interface StoredTokens extends GoogleTokens {
  scope?: string;
}

export function getGoogleClientId(): string {
  // Platform-aware: Android builds use the Android OAuth client; other platforms fall back to
  // the same value (there's no iOS/web client configured yet).
  return (Constants.expoConfig?.extra?.googleAndroidClientId as string) || '';
}

/** True when this build can offer Google connect (client ID baked in). */
export function isGoogleConnectAvailable(): boolean {
  return getGoogleClientId().length > 0;
}

export async function getStoredTokens(): Promise<StoredTokens | null> {
  try {
    const raw = await SecureStore.getItemAsync(TOKENS_KEY);
    return raw ? (JSON.parse(raw) as StoredTokens) : null;
  } catch {
    return null;
  }
}

async function storeTokens(tokens: StoredTokens): Promise<void> {
  await SecureStore.setItemAsync(TOKENS_KEY, JSON.stringify(tokens));
}

/** Whether a Google account is connected with usable tokens. */
export async function isGoogleConnected(): Promise<boolean> {
  const t = await getStoredTokens();
  return !!t?.accessToken;
}

function extractEmailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const payload = idToken.split('.')[1];
    // base64url → base64; atob is available on Hermes/RN
    const json = globalThis.atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const parsed = JSON.parse(json);
    return typeof parsed?.email === 'string' ? parsed.email : null;
  } catch {
    return null;
  }
}

/**
 * Interactive sign-in + consent. Resolves to the connected account's tokens, or null if the
 * user dismissed the browser sheet. Throws on exchange/network failure - callers should show
 * a retryable error, not crash.
 */
export async function connectGoogleAccount(loginHint?: string): Promise<GoogleTokens | null> {
  const clientId = getGoogleClientId();
  if (!clientId) throw new Error('Google sign-in is not configured in this build');

  const discovery: AuthSession.DiscoveryDocument = {
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: TOKEN_ENDPOINT,
    revocationEndpoint: REVOKE_ENDPOINT,
  };

  const redirectUri = AuthSession.makeRedirectUri({
    // Google's Android OAuth clients reject bare custom schemes (nueco://) with
    // Error 400: invalid_request - only reverse-DNS-style schemes are accepted. Use the
    // package name as scheme; it's registered as an intent filter in app.json.
    native: `${Constants.expoConfig?.android?.package}:/oauth2redirect`,
    scheme: 'nueco',
    path: 'oauth2redirect',
  });

  const request = new AuthSession.AuthRequest({
    clientId,
    responseType: AuthSession.ResponseType.Code,
    scopes: SCOPES,
    redirectUri,
    // PKCE + offline access: native public clients get a refresh token only when asking for
    // offline access and (re-)consent.
    codeChallengeMethod: AuthSession.CodeChallengeMethod.S256,
    extraParams: {
      access_type: 'offline',
      prompt: 'consent',
      // When the Nueco account is a Gmail address, preselect it on Google's side so the
      // user skips the account chooser and lands straight on the consent page.
      ...(loginHint ? { login_hint: loginHint } : {}),
    },
  });

  const result = await request.promptAsync(discovery, {
    // Android: keep the Custom Tab warm so the round-trip is fast.
    showInRecents: false,
  });

  if (result.type === 'dismiss') return null;
  if (result.type !== 'success' || !result.params?.code) {
    throw new Error('Google sign-in did not complete');
  }

  if (!request.codeVerifier) throw new Error('PKCE verifier missing - cannot exchange code');
  const exchange = await AuthSession.exchangeCodeAsync(
    {
      clientId,
      code: result.params.code,
      redirectUri,
      // PKCE: the verifier proves this app generated the challenge sent in the authorize step.
      extraParams: { code_verifier: request.codeVerifier },
    },
    discovery
  );

  const tokens: StoredTokens = {
    accessToken: exchange.accessToken,
    refreshToken: exchange.refreshToken ?? null,
    expiresAt: Date.now() + (exchange.expiresIn ?? 3600) * 1000,
    email: extractEmailFromIdToken((exchange as { idToken?: string }).idToken),
    scope: exchange.scope,
  };
  if (!tokens.refreshToken && Platform.OS === 'android') {
    // Without a refresh token the connection dies in an hour. Refuse rather than silently
    // degrade - the user can retry (a fresh consent typically yields one).
    throw new Error('Google did not issue a refresh token; try disconnecting and reconnecting');
  }
  await storeTokens(tokens);
  return tokens;
}

/**
 * Returns a valid access token, silently refreshing when near expiry. Returns null only when
 * no account is connected, or the refresh was permanently rejected (revoked/disabled) - in
 * that case the stored tokens are cleared so the UI drops back to "disconnected".
 */
export async function getValidAccessToken(): Promise<string | null> {
  const tokens = await getStoredTokens();
  if (!tokens) return null;
  if (Date.now() < tokens.expiresAt - REFRESH_SKEW_MS) return tokens.accessToken;

  if (!tokens.refreshToken) {
    // No refresh token and expired: connection is dead.
    await disconnectGoogleAccount(false);
    return null;
  }

  try {
    const refreshed = await AuthSession.refreshAsync(
      {
        clientId: getGoogleClientId(),
        refreshToken: tokens.refreshToken,
      },
      { tokenEndpoint: TOKEN_ENDPOINT }
    );
    const updated: StoredTokens = {
      ...tokens,
      accessToken: refreshed.accessToken,
      // Google may or may not rotate the refresh token; keep whichever we got.
      refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
      expiresAt: Date.now() + (refreshed.expiresIn ?? 3600) * 1000,
    };
    await storeTokens(updated);
    return updated.accessToken;
  } catch {
    // Invalid_grant (revoked, password changed, app uninstalled from consent screen) is not
    // retryable - drop the connection so the user sees "disconnected" instead of failing syncs.
    await disconnectGoogleAccount(false);
    return null;
  }
}

/**
 * Disconnect: optionally revoke the grant server-side (best-effort), then wipe local tokens.
 * Safe to call when nothing is connected. Callers should also clear sync state + bridge fields
 * on the events (see googleSync.ts) - this module only owns the credential.
 */
export async function disconnectGoogleAccount(revoke: boolean = true): Promise<void> {
  const tokens = await getStoredTokens();
  if (tokens && revoke) {
    const tokenToRevoke = tokens.refreshToken || tokens.accessToken;
    try {
      await fetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(tokenToRevoke)}`, {
        method: 'POST',
      });
    } catch {
      // Best-effort: local wipe below is what actually stops sync.
    }
  }
  try {
    await SecureStore.deleteItemAsync(TOKENS_KEY);
  } catch {}
}
