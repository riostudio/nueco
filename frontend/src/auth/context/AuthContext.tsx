import React, { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { Platform } from 'react-native';
import { User } from '../types/auth.types';
import { authApi } from '../api/authApi';
import { dailyBrewApi } from '../../api';
import { authStorage } from '../storage/authStorage';
import { fullSync, processSyncQueue } from '../../offlineSync';
import { E2EE_KEYS_ENABLED } from '../../crypto/flags';
import { bootstrapKeyOnLogin, recoverKeyWithCode, clearKeyOnLogout, type BootstrapResult } from '../../crypto/keySession';
import { migrateNotesToEncrypted } from '../../crypto/noteMigration';
import { migrateEventsToEncrypted } from '../../crypto/eventMigration';
import { UNDECRYPTABLE_PLACEHOLDER } from '../../crypto/accountCrypto';
import { loadDek } from '../../crypto/keystore';
import { resetCalendarSyncState } from '../../calendarSync';
import { clearCachedBrew } from '../../dailyBrew/dailyBrew';
import { runLoginWorkflow } from '../loginWorkflow';

// Account name E2EE (Stage 5) reversed: push the already-decrypted plaintext name (every
// place `User` reaches app code has already run it through decryptAccountFromServer) back to
// the server and clear enc_version, undoing the one-time encryption push this used to do.
// Runs from both login() and refreshAuth() (the latter fires on every cold start via
// initAuth(), see below) so an already-logged-in session self-heals without requiring an
// explicit log-out/log-in. Guarded on loadDek() being non-null: with no DEK, decrypt is a
// no-op pass-through, so `user.name` is still ciphertext - pushing that back as "plaintext"
// would permanently bake the ciphertext in as the display name with no way to recover it.
// Front-loads the calendar permission prompt right after login instead of waiting for the user
// to first create/edit an event - so event-editor's device-calendar write and Nueco's own
// sync queue both have access from the start. Safe to call on every login: if permission was
// already granted (or permanently denied), requestCalendarPermissionsAsync resolves immediately
// with no UI, same as the OS does for any repeat request.
async function requestCalendarSyncPermission(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const ExpoCalendar = require('expo-calendar');
    await ExpoCalendar.requestCalendarPermissionsAsync();
  } catch (e) {
    console.warn('Calendar permission request failed:', e);
  }
}

async function pushBackPlaintextName(user: User | null | undefined): Promise<void> {
  if (!user?.enc_version || !user?.name || user.name === UNDECRYPTABLE_PLACEHOLDER) return;
  try {
    if (await loadDek()) {
      await authApi.updateName(user.name, null);
    }
  } catch (e) {
    console.warn('Account name plaintext push-back failed (will retry next login):', e);
  }
}

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  isSyncReady: boolean;
  /** Resolves to the E2EE key-bootstrap result (null when E2EE keys are disabled). */
  login: (email: string, password: string) => Promise<BootstrapResult | null>;
  logout: () => Promise<void>;
  refreshAuth: () => Promise<boolean>;
  /** One-time recovery code to display after a fresh escrow is created; null otherwise. */
  recoveryCode: string | null;
  /** Clear the recovery code once the user has acknowledged saving it. */
  acknowledgeRecoveryCode: () => void;
  /** Complete post-reset recovery using the user's recovery code. */
  recoverKey: (recoveryCode: string) => Promise<void>;
  /** Correct your account display name (APP 13 / GDPR Art. 16 right to rectification). */
  updateUserName: (name: string) => Promise<void>;
  /** Save Daily Brew news-source preferences and sync the result back into the in-memory
   * user immediately - without this, news-source-settings.tsx would keep reading the
   * pre-save snapshot from context until the next full refreshAuth()/getMe(). */
  updateNewsPreferences: (country: string, outletIds: string[], showVerse: boolean, showQuote?: boolean) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncReady, setIsSyncReady] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  // Password from the current login, held in memory only to complete a post-reset
  // recovery re-wrap (never persisted). Cleared once recovery succeeds or on logout.
  const pendingPasswordRef = useRef<string | null>(null);

  const refreshAuth = useCallback(async (): Promise<boolean> => {
    try {
      const result = await authApi.refreshToken();
      if (result) {
        setUser(result.user);
        pushBackPlaintextName(result.user);
        return true;
      }
      // null means either 401/403 (tokens cleared) or network error (tokens kept).
      // Only log out if tokens were actually cleared by the server rejecting them.
      const stillHasToken = await authStorage.getAccessToken();
      if (!stillHasToken) {
        setUser(null);
      }
      return false;
    } catch {
      setUser(null);
      return false;
    }
  }, []);

  // Check for existing session on mount
  useEffect(() => {
    const initAuth = async () => {
      try {
        const storedUser = await authStorage.getUser();
        if (storedUser) {
          setUser(storedUser as User);
          // Try to refresh token in background (with proper error handling)
          refreshAuth().catch(err => {
            console.warn('Background token refresh failed:', err);
            // Don't clear user state - token might still be valid
          });
        } else {
          // No cached user, but the tokens are dual-stored (AsyncStorage + SecureStore)
          // and more resilient than the SecureStore-only cached user object, which some
          // Android OEMs evict independently. If a token survived, refetch the user
          // instead of forcing a fresh login (which would orphan local notes).
          const token = (await authStorage.getAccessToken()) || (await authStorage.getRefreshToken());
          if (token) {
            try {
              const me = await authApi.getMe();
              setUser(me);
              await authStorage.setUser(me);
              pushBackPlaintextName(me);
            } catch (err) {
              // Access token likely expired - fall back to a full refresh.
              await refreshAuth();
            }
          }
        }
      } catch (error) {
        console.error('Auth init error:', error);
      } finally {
        setIsLoading(false);
      }
    };

    initAuth();
  }, [refreshAuth]);

  const login = useCallback(async (email: string, password: string): Promise<BootstrapResult | null> => {
    const result = await authApi.login(email, password);
    // Set user first so auth state is ready
    setUser(result.user);
    setIsSyncReady(false);

    // Sequencing/branching (what runs when, and why) lives in loginWorkflow.ts, framework-free
    // and independently testable. This callback just wires it to React state + the real deps.
    const { bootstrap, pendingPassword } = await runLoginWorkflow(password, result.user, {
      e2eeKeysEnabled: E2EE_KEYS_ENABLED,
      bootstrapKeyOnLogin,
      fullSync,
      migrateNotesToEncrypted,
      migrateEventsToEncrypted,
      getMe: () => authApi.getMe(),
      pushBackPlaintextName,
      requestCalendarSyncPermission,
      onSyncReadyChange: setIsSyncReady,
      onUserRefetched: setUser,
      warn: (message, err) => console.warn(message, err),
    });

    if (bootstrap?.status === 'created') {
      setRecoveryCode(bootstrap.recoveryCode);
    }
    if (pendingPassword) {
      pendingPasswordRef.current = pendingPassword;
    }

    return bootstrap;
  }, []);

  const acknowledgeRecoveryCode = useCallback(() => {
    setRecoveryCode(null);
  }, []);

  const recoverKey = useCallback(async (code: string) => {
    const password = pendingPasswordRef.current;
    if (!password) throw new Error('No pending recovery session');
    await recoverKeyWithCode(code, password);
    pendingPasswordRef.current = null;
    // The pre-recovery fullSync was skipped by the no-DEK guard; pull now that the key exists.
    fullSync({ force: true }).catch(() => {});
  }, []);

  const updateUserName = useCallback(async (name: string) => {
    const updated = await authApi.updateName(name, null);
    setUser(updated);
  }, []);

  const updateNewsPreferences = useCallback(async (country: string, outletIds: string[], showVerse: boolean, showQuote = false) => {
    const updated = await dailyBrewApi.updateNewsPreferences(country, outletIds, showVerse, showQuote) as User;
    setUser(updated);
    await authStorage.setUser(updated);
    // Otherwise DailyBrewCard's freshness check keeps trusting the pre-change cache for up to
    // REVALIDATE_INTERVAL_MS, showing headlines from sources just removed.
    await clearCachedBrew(updated.id);
  }, []);

  const logout = useCallback(async () => {
    // Flush pending pushes while the session token AND the DEK are still live. Without
    // this, an unawaited processSyncQueue from the editor's back navigation can race the
    // clearKeyOnLogout below and encrypt with no key loaded (refused by the encrypt
    // guard), or worse, push plaintext that the server stores under enc_version=1.
    await processSyncQueue().catch(() => {});
    await authApi.logout();
    if (E2EE_KEYS_ENABLED) {
      try {
        await clearKeyOnLogout();
      } catch (e) {
        console.warn('E2EE key clear on logout failed:', e);
      }
    }
    try {
      await resetCalendarSyncState();
    } catch (e) {
      console.warn('Calendar sync state clear on logout failed:', e);
    }
    pendingPasswordRef.current = null;
    setRecoveryCode(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        isAuthenticated: !!user,
        isSyncReady,
        login,
        logout,
        refreshAuth,
        recoveryCode,
        acknowledgeRecoveryCode,
        recoverKey,
        updateUserName,
        updateNewsPreferences,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
