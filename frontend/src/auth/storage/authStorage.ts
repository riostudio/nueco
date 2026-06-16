import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEYS = {
  ACCESS_TOKEN: 'access_token',
  REFRESH_TOKEN: 'refresh_token',
  USER: 'user_data',
  MODAL_DISMISSED: 'signup_modal_dismissed',
  FIRST_NOTE_SAVED: 'first_note_saved',
};

// Use SecureStore on native, AsyncStorage on web
const isWeb = Platform.OS === 'web';

export const authStorage = {
  // Access token - stored in memory on native, AsyncStorage on web
  setAccessToken: async (token: string): Promise<void> => {
    if (isWeb) {
      await AsyncStorage.setItem(KEYS.ACCESS_TOKEN, token);
    } else {
      try {
        await SecureStore.setItemAsync(KEYS.ACCESS_TOKEN, token);
      } catch (e) {
        console.error('SecureStore setAccessToken failed, falling back to AsyncStorage:', e);
      }
      // Always write to AsyncStorage as fallback
      await AsyncStorage.setItem(KEYS.ACCESS_TOKEN, token);
    }
  },

  getAccessToken: async (): Promise<string | null> => {
    if (isWeb) {
      return await AsyncStorage.getItem(KEYS.ACCESS_TOKEN);
    }
    try {
      const token = await SecureStore.getItemAsync(KEYS.ACCESS_TOKEN);
      if (token) return token;
      // Fallback to AsyncStorage if SecureStore returns null
      return await AsyncStorage.getItem(KEYS.ACCESS_TOKEN);
    } catch (e) {
      console.error('SecureStore getAccessToken failed, falling back to AsyncStorage:', e);
      return await AsyncStorage.getItem(KEYS.ACCESS_TOKEN);
    }
  },

  // Refresh token - stored securely
  setRefreshToken: async (token: string): Promise<void> => {
    if (isWeb) {
      await AsyncStorage.setItem(KEYS.REFRESH_TOKEN, token);
    } else {
      await SecureStore.setItemAsync(KEYS.REFRESH_TOKEN, token);
    }
  },

  getRefreshToken: async (): Promise<string | null> => {
    if (isWeb) {
      return await AsyncStorage.getItem(KEYS.REFRESH_TOKEN);
    }
    return await SecureStore.getItemAsync(KEYS.REFRESH_TOKEN);
  },

  // User data
  setUser: async (user: object): Promise<void> => {
    const json = JSON.stringify(user);
    if (isWeb) {
      await AsyncStorage.setItem(KEYS.USER, json);
    } else {
      await SecureStore.setItemAsync(KEYS.USER, json);
    }
  },

  getUser: async (): Promise<object | null> => {
    try {
      let json: string | null;
      if (isWeb) {
        json = await AsyncStorage.getItem(KEYS.USER);
      } else {
        json = await SecureStore.getItemAsync(KEYS.USER);
      }
      return json ? JSON.parse(json) : null;
    } catch {
      return null;
    }
  },

  // Clear all auth data
  clearAll: async (): Promise<void> => {
    if (isWeb) {
      await AsyncStorage.multiRemove([KEYS.ACCESS_TOKEN, KEYS.REFRESH_TOKEN, KEYS.USER]);
    } else {
      await SecureStore.deleteItemAsync(KEYS.ACCESS_TOKEN);
      await SecureStore.deleteItemAsync(KEYS.REFRESH_TOKEN);
      await SecureStore.deleteItemAsync(KEYS.USER);
      await AsyncStorage.multiRemove([KEYS.ACCESS_TOKEN, KEYS.REFRESH_TOKEN, KEYS.USER]);
    }
  },

  // Modal dismissed state (for signup prompts)
  isModalDismissed: async (): Promise<boolean> => {
    try {
      if (isWeb) {
        const value = await AsyncStorage.getItem(KEYS.MODAL_DISMISSED);
        return value === 'true';
      }
      const value = await SecureStore.getItemAsync(KEYS.MODAL_DISMISSED);
      return value === 'true';
    } catch {
      return false;
    }
  },

  setModalDismissed: async (dismissed: boolean): Promise<void> => {
    const value = dismissed ? 'true' : 'false';
    if (isWeb) {
      await AsyncStorage.setItem(KEYS.MODAL_DISMISSED, value);
    } else {
      await SecureStore.setItemAsync(KEYS.MODAL_DISMISSED, value);
    }
  },

  // First note saved state (for signup prompts)
  setFirstNoteSaved: async (): Promise<void> => {
    if (isWeb) {
      await AsyncStorage.setItem(KEYS.FIRST_NOTE_SAVED, 'true');
    } else {
      await SecureStore.setItemAsync(KEYS.FIRST_NOTE_SAVED, 'true');
    }
  },

  isFirstNoteSaved: async (): Promise<boolean> => {
    try {
      if (isWeb) {
        const value = await AsyncStorage.getItem(KEYS.FIRST_NOTE_SAVED);
        return value === 'true';
      }
      const value = await SecureStore.getItemAsync(KEYS.FIRST_NOTE_SAVED);
      return value === 'true';
    } catch {
      return false;
    }
  },
};
