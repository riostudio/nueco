import { RegisterDeviceRequest, LinkAccountRequest, ChangePasswordRequest, User } from '../types/auth.types';

const BASE_URL = process.env.EXPO_PUBLIC_BACKEND_URL;

const headers = {
  'Content-Type': 'application/json',
};

export const authApi = {
  registerDevice: async (body: RegisterDeviceRequest): Promise<{ success: boolean; user: User }> => {
    const res = await fetch(`${BASE_URL}/api/auth/device`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    return res.json();
  },

  linkAccount: async (body: LinkAccountRequest): Promise<{ success: boolean; user: User }> => {
    const res = await fetch(`${BASE_URL}/api/auth/link`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.message || 'Failed to link account');
    }
    return res.json();
  },

  changePassword: async (body: ChangePasswordRequest): Promise<{ success: boolean; message: string }> => {
    const res = await fetch(`${BASE_URL}/api/auth/change-password`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      throw { ...data, status: res.status };
    }
    return data;
  },
};
