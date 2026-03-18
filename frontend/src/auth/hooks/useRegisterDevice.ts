import { useState, useCallback } from 'react';
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import { authApi } from '../api/authApi';
import { authStorage } from '../storage/authStorage';
import { User, Result } from '../types/auth.types';

export function useRegisterDevice() {
  const [isLoading, setIsLoading] = useState(false);
  const [user, setUser] = useState<User | null>(null);

  const registerDevice = useCallback(async (): Promise<Result<User>> => {
    setIsLoading(true);
    try {
      // Get or create device ID
      let deviceId = await authStorage.getDeviceId();
      if (!deviceId) {
        deviceId = Crypto.randomUUID();
        await authStorage.setDeviceId(deviceId);
      }

      // Collect device info
      const deviceModel = Device.modelName || 'Unknown';
      const osVersion = Device.osVersion || 'Unknown';

      // Register device
      const response = await authApi.registerDevice({
        device_id: deviceId,
        device_model: deviceModel,
        os_version: osVersion,
      });

      if (response.success) {
        setUser(response.user);
        await authStorage.setUser(response.user);
        return { success: true, data: response.user };
      }
      return { success: false, error: 'Registration failed', code: 0 };
    } catch (error) {
      console.error('Device registration error:', error);
      return { success: false, error: String(error), code: 0 };
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { registerDevice, isLoading, user };
}
