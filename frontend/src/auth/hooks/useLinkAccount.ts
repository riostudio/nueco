import { useState, useCallback } from 'react';
import { authApi } from '../api/authApi';
import { authStorage } from '../storage/authStorage';
import { User, Result, LinkAccountRequest } from '../types/auth.types';

export function useLinkAccount() {
  const [isLoading, setIsLoading] = useState(false);

  const linkAccount = useCallback(async (
    email?: string,
    mobile_number?: string,
    password?: string
  ): Promise<Result<User>> => {
    setIsLoading(true);
    try {
      const deviceId = await authStorage.getDeviceId();
      if (!deviceId) {
        return { success: false, error: 'Device not registered', code: 0 };
      }

      const body: LinkAccountRequest = { device_id: deviceId };
      if (email) body.email = email;
      if (mobile_number) body.mobile_number = mobile_number;
      if (password) body.password = password;

      const response = await authApi.linkAccount(body);

      if (response.success) {
        await authStorage.setUser(response.user);
        return { success: true, data: response.user };
      }
      return { success: false, error: 'Link failed', code: 0 };
    } catch (error: any) {
      console.error('Link account error:', error);
      return { success: false, error: error.message || String(error), code: 0 };
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { linkAccount, isLoading };
}
