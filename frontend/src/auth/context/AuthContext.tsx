import React, { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { User } from '../types/auth.types';
import { authApi } from '../api/authApi';
import { authStorage } from '../storage/authStorage';
import { fullSync } from '../../offlineSync';

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  isSyncReady: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshAuth: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncReady, setIsSyncReady] = useState(false);

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
        }
      } catch (error) {
        console.error('Auth init error:', error);
      } finally {
        setIsLoading(false);
      }
    };

    initAuth();
  }, [refreshAuth]);

  const login = useCallback(async (email: string, password: string) => {
    const result = await authApi.login(email, password);
    // Set user first so auth state is ready
    setUser(result.user);
    setIsSyncReady(false);
    // Run fullSync after tokens are saved
    try {
      await fullSync();
    } catch (e) {
      console.warn('Post-login sync failed:', e);
    } finally {
      // Signal that sync is complete so the notes screen can reload from AsyncStorage
      setIsSyncReady(true);
    }
  }, []);

  const logout = useCallback(async () => {
    await authApi.logout();
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
