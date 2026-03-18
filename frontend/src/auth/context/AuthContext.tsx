import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { authStorage } from '../storage/authStorage';
import { authApi } from '../api/authApi';
import { User } from '../types/auth.types';
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isFirstLaunch: boolean;
  refreshUser: () => Promise<void>;
  clearAllData: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isFirstLaunch, setIsFirstLaunch] = useState(false);

  const initAuth = useCallback(async () => {
    try {
      // Check if this is first launch (no device ID)
      let deviceId = await authStorage.getDeviceId();
      const isFirst = !deviceId;
      setIsFirstLaunch(isFirst);

      if (!deviceId) {
        deviceId = Crypto.randomUUID();
        await authStorage.setDeviceId(deviceId);
      }

      // Check for stored user
      const storedUser = await authStorage.getUser();
      if (storedUser) {
        setUser(JSON.parse(storedUser));
      }

      // Register device in background
      const deviceModel = Device.modelName || 'Unknown';
      const osVersion = Device.osVersion || 'Unknown';

      const response = await authApi.registerDevice({
        device_id: deviceId,
        device_model: deviceModel,
        os_version: osVersion,
      });

      if (response.success) {
        setUser(response.user);
        await authStorage.setUser(response.user);
      }
    } catch (error) {
      console.error('Auth init error:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    initAuth();
  }, [initAuth]);

  const refreshUser = useCallback(async () => {
    try {
      const storedUser = await authStorage.getUser();
      if (storedUser) {
        setUser(JSON.parse(storedUser));
      }
    } catch (error) {
      console.error('Refresh user error:', error);
    }
  }, []);

  const clearAllData = useCallback(async () => {
    try {
      await authStorage.setDeviceId('');
      await authStorage.clearUser();
      // Clear the dismissed modal flag
      const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
      await AsyncStorage.multiRemove(['device_id', 'modal_dismissed', 'first_note_saved', 'auth_user']);
      setUser(null);
      setIsFirstLaunch(true);
    } catch (error) {
      console.error('Clear data error:', error);
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, isLoading, isFirstLaunch, refreshUser, clearAllData }}>
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
