import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { User } from '../types/auth.types';
import { authApi } from '../api/authApi';
import { authStorage } from '../storage/authStorage';

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshAuth: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refreshAuth = useCallback(async (): Promise<boolean> => {
    try {
      const result = await authApi.refreshToken();
      if (result) {
        setUser(result.user);
        return true;
      }
      setUser(null);
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
    // Token is now saved — sync notes immediately before navigating
    try {
      const { fullSync } = require('../offlineSync');
      await fullSync();
    } catch (e) {
      console.warn('Post-login sync failed:', e);
    }
    setUser(result.user);
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
