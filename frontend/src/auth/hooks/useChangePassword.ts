import { useState, useCallback } from 'react';
import { authApi } from '../api/authApi';
import { authStorage } from '../storage/authStorage';
import { Result } from '../types/auth.types';

export function useChangePassword() {
  const [isLoading, setIsLoading] = useState(false);

  const changePassword = useCallback(async (
    currentPassword: string,
    newPassword: string
  ): Promise<Result<string>> => {
    setIsLoading(true);
    try {
      const deviceId = await authStorage.getDeviceId();
      if (!deviceId) {
        return { success: false, error: 'Device not registered', code: 0 };
      }

      const response = await authApi.changePassword({
        device_id: deviceId,
        current_password: currentPassword,
        new_password: newPassword,
      });

      return { success: true, data: response.message };
    } catch (error: any) {
      console.error('Change password error:', error);
      const code = error.status || 0;
      return { success: false, error: error.message || String(error), code };
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { changePassword, isLoading };
}
