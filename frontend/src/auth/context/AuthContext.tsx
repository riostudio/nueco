import React, { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { User } from '../types/auth.types';
import { authApi } from '../api/authApi';
import { authStorage } from '../storage/authStorage';
import { fullSync } from '../../offlineSync';
import { E2EE_KEYS_ENABLED } from '../../crypto/flags';
import { bootstrapKeyOnLogin, recoverKeyWithCode, clearKeyOnLogout, type BootstrapResult } from '../../crypto/keySession';

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

    // E2EE key bootstrap (Stage 3): establish the DEK in the device keystore now
    // that we have both a session and the password. Gated by feature flag.
    let bootstrap: BootstrapResult | null = null;
    if (E2EE_KEYS_ENABLED) {
      try {
        bootstrap = await bootstrapKeyOnLogin(password);
        if (bootstrap.status === 'created') {
          setRecoveryCode(bootstrap.recoveryCode);
        } else if (bootstrap.status === 'needs_recovery') {
          // Hold the new password to complete the recovery re-wrap.
          pendingPasswordRef.current = password;
        }
      } catch (e) {
        // Don't block login on a key-bootstrap failure (e.g. transient network);
        // it will be retried on the next login. Notes aren't encrypted yet (Stage 4).
        console.warn('E2EE key bootstrap failed:', e);
      }
    }

    // Run fullSync after tokens are saved
    try {
      await fullSync();
    } catch (e) {
      console.warn('Post-login sync failed:', e);
    } finally {
      // Signal that sync is complete so the notes screen can reload from AsyncStorage
      setIsSyncReady(true);
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
  }, []);

  const logout = useCallback(async () => {
    await authApi.logout();
    if (E2EE_KEYS_ENABLED) {
      try {
        await clearKeyOnLogout();
      } catch (e) {
        console.warn('E2EE key clear on logout failed:', e);
      }
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
