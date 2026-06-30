import { useState, useCallback } from 'react';
import { authApi } from '../api/authApi';
import { Result } from '../types/auth.types';
import { E2EE_KEYS_ENABLED } from '../../crypto/flags';
import { rewrapDekForNewPassword } from '../../crypto/keySession';

export function useChangePassword() {
  const [isLoading, setIsLoading] = useState(false);

  const changePassword = useCallback(async (
    currentPassword: string,
    newPassword: string
  ): Promise<Result<string>> => {
    setIsLoading(true);
    try {
      const response = await authApi.changePassword({
        current_password: currentPassword,
        new_password: newPassword,
        confirm_password: newPassword,
      });

      // Keep the E2EE escrow in sync: re-wrap the in-device DEK under the new
      // password so future logins unlock it. No-op if keys aren't bootstrapped.
      if (E2EE_KEYS_ENABLED) {
        try {
          await rewrapDekForNewPassword(newPassword);
        } catch (e) {
          console.warn('E2EE re-wrap after password change failed:', e);
        }
      }

      return { success: true, data: response.message };
    } catch (error: any) {
      console.error('Change password error:', error);
      const code = error.code || error.status || 0;
      return { success: false, error: error.message || String(error), code };
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { changePassword, isLoading };
}
