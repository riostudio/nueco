import AsyncStorage from '@react-native-async-storage/async-storage';

const KEYS = {
  DEVICE_ID: 'device_id',
  MODAL_DISMISSED: 'modal_dismissed',
  FIRST_NOTE_SAVED: 'first_note_saved',
  USER: 'auth_user',
};

export const authStorage = {
  getDeviceId: async (): Promise<string | null> => {
    return AsyncStorage.getItem(KEYS.DEVICE_ID);
  },
  setDeviceId: async (id: string): Promise<void> => {
    await AsyncStorage.setItem(KEYS.DEVICE_ID, id);
  },
  isModalDismissed: async (): Promise<boolean> => {
    const value = await AsyncStorage.getItem(KEYS.MODAL_DISMISSED);
    return value === 'true';
  },
  dismissModal: async (): Promise<void> => {
    await AsyncStorage.setItem(KEYS.MODAL_DISMISSED, 'true');
  },
  isFirstNoteSaved: async (): Promise<boolean> => {
    const value = await AsyncStorage.getItem(KEYS.FIRST_NOTE_SAVED);
    return value === 'true';
  },
  setFirstNoteSaved: async (): Promise<void> => {
    await AsyncStorage.setItem(KEYS.FIRST_NOTE_SAVED, 'true');
  },
  getUser: async (): Promise<string | null> => {
    return AsyncStorage.getItem(KEYS.USER);
  },
  setUser: async (user: object): Promise<void> => {
    await AsyncStorage.setItem(KEYS.USER, JSON.stringify(user));
  },
  clearUser: async (): Promise<void> => {
    await AsyncStorage.removeItem(KEYS.USER);
  },
};
