import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { AppState, AppStateStatus } from 'react-native';
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
  logout: () => Promise<void>;
  clearAllData: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isFirstLaunch, setIsFirstLaunch] = useState(false);

  const fetchUserFromServer = useCallback(async () => {
    try {
      const deviceId = await authStorage.getDeviceId();
      if (!deviceId) return;

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
      console.error('Fetch user error:', error);
    }
  }, []);

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

      // Register device in background - don't block on this
      fetchUserFromServer();
    } catch (error) {
      console.error('Auth init error:', error);
    }
  }, [fetchUserFromServer]);

  useEffect(() => {
    initAuth();
  }, [initAuth]);

  // Refresh user when app comes to foreground (after email verification)
  useEffect(() => {
    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      if (nextAppState === 'active') {
        // App came to foreground, refresh user data
        fetchUserFromServer();
      }
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => subscription.remove();
  }, [fetchUserFromServer]);

  const refreshUser = useCallback(async () => {
    await fetchUserFromServer();
  }, [fetchUserFromServer]);

  // Logout function - keeps local notes but clears account link
  const logout = useCallback(async () => {
    try {
      // Generate new device ID to act as a new user
      const newDeviceId = Crypto.randomUUID();
      await authStorage.setDeviceId(newDeviceId);
      
      // Clear user data but keep modal dismissed flag so they can sign in later
      await authStorage.clearUser();
      
      // Clear the first note saved flag so sign-up prompt can show again
      const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
      await AsyncStorage.removeItem('first_note_saved');
      
      // Reset modal dismissed so they can see sign-in option
      await AsyncStorage.removeItem('modal_dismissed');
      
      setUser(null);
      
      // Register the new device
      await fetchUserFromServer();
    } catch (error) {
      console.error('Logout error:', error);
    }
  }, [fetchUserFromServer]);

  const clearAllData = useCallback(async () => {
    try {
      await authStorage.setDeviceId('');
      await authStorage.clearUser();
      const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
      await AsyncStorage.multiRemove(['device_id', 'modal_dismissed', 'first_note_saved', 'auth_user']);
      setUser(null);
      setIsFirstLaunch(true);
    } catch (error) {
      console.error('Clear data error:', error);
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, isLoading, isFirstLaunch, refreshUser, logout, clearAllData }}>
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
