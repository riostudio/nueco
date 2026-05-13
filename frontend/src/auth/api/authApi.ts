import { Platform } from 'react-native';
import * as Device from 'expo-device';
import { User, AuthResponse, MessageResponse, SyncStatus, SignUpData, LoginData, ChangePasswordData } from '../types/auth.types';
import { authStorage } from '../storage/authStorage';
import { BACKEND_API_BASE_URL } from '../../backendBaseUrl';

class AuthApiService {
  private async getHeaders(includeAuth: boolean = false): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    
    if (includeAuth) {
      const token = await authStorage.getAccessToken();
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
    }
    
    return headers;
  }

  private getDeviceInfo() {
    return {
      device_name: Device.modelName || 'Unknown Device',
      platform: Platform.OS,
    };
  }

  async signup(data: SignUpData): Promise<MessageResponse> {
    const response = await fetch(`${BACKEND_API_BASE_URL}/auth/signup`, {
      method: 'POST',
      headers: await this.getHeaders(),
      body: JSON.stringify(data),
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.detail || 'Signup failed');
    }
    return result;
  }

  async login(email: string, password: string): Promise<AuthResponse> {
    const deviceInfo = this.getDeviceInfo();
    
    try {
      const response = await fetch(`${BACKEND_API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: await this.getHeaders(),
        body: JSON.stringify({
          email,
          password,
          ...deviceInfo,
        }),
      });

      // Check if response is JSON
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        const text = await response.text();
        console.error('Non-JSON response:', text.substring(0, 200));
        throw new Error('Server returned an invalid response. Please try again.');
      }

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.detail || 'Login failed');
      }

      // Store tokens
      await authStorage.setAccessToken(result.access_token);
      await authStorage.setRefreshToken(result.refresh_token);
      await authStorage.setUser(result.user);

      return result;
    } catch (error: any) {
      // Handle network errors
      if (error.message === 'Network request failed') {
        throw new Error('Unable to connect to server. Please check your internet connection.');
      }
      // Handle JSON parse errors
      if (error.message?.includes('JSON')) {
        throw new Error('Server returned an invalid response. Please try again.');
      }
      throw error;
    }
  }

  async logout(): Promise<void> {
    try {
      const refreshToken = await authStorage.getRefreshToken();
      if (refreshToken) {
        await fetch(`${BACKEND_API_BASE_URL}/auth/logout`, {
          method: 'POST',
          headers: await this.getHeaders(),
          body: JSON.stringify({ refresh_token: refreshToken }),
        });
      }
    } finally {
      await authStorage.clearAll();
    }
  }

  async refreshToken(): Promise<AuthResponse | null> {
    const refreshToken = await authStorage.getRefreshToken();
    if (!refreshToken) return null;

    try {
      const response = await fetch(`${BACKEND_API_BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: await this.getHeaders(),
        body: JSON.stringify({ refresh_token: refreshToken }),
      });

      if (!response.ok) {
        await authStorage.clearAll();
        return null;
      }

      const result = await response.json();
      await authStorage.setAccessToken(result.access_token);
      await authStorage.setUser(result.user);
      return result;
    } catch {
      await authStorage.clearAll();
      return null;
    }
  }

  async getMe(): Promise<User> {
    const response = await fetch(`${BACKEND_API_BASE_URL}/auth/me`, {
      headers: await this.getHeaders(true),
    });

    if (!response.ok) {
      throw new Error('Failed to get user info');
    }

    return response.json();
  }

  async forgotPassword(email: string): Promise<MessageResponse> {
    const response = await fetch(`${BACKEND_API_BASE_URL}/auth/forgot-password`, {
      method: 'POST',
      headers: await this.getHeaders(),
      body: JSON.stringify({ email }),
    });

    return response.json();
  }

  async resetPassword(token: string, newPassword: string, confirmPassword: string): Promise<MessageResponse> {
    const response = await fetch(`${BACKEND_API_BASE_URL}/auth/reset-password`, {
      method: 'POST',
      headers: await this.getHeaders(),
      body: JSON.stringify({
        token,
        new_password: newPassword,
        confirm_password: confirmPassword,
      }),
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.detail || 'Reset failed');
    }
    return result;
  }

  async changePassword(data: ChangePasswordData): Promise<MessageResponse> {
    const response = await fetch(`${BACKEND_API_BASE_URL}/auth/change-password`, {
      method: 'POST',
      headers: await this.getHeaders(true),
      body: JSON.stringify(data),
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.detail || 'Change password failed');
    }
    return result;
  }

  async resendVerification(email: string): Promise<MessageResponse> {
    const response = await fetch(`${BACKEND_API_BASE_URL}/auth/resend-verification`, {
      method: 'POST',
      headers: await this.getHeaders(),
      body: JSON.stringify({ email }),
    });

    return response.json();
  }

  async getSyncStatus(): Promise<SyncStatus> {
    const response = await fetch(`${BACKEND_API_BASE_URL}/auth/sync-status`, {
      headers: await this.getHeaders(true),
    });

    if (!response.ok) {
      throw new Error('Failed to get sync status');
    }

    return response.json();
  }
}

export const authApi = new AuthApiService();
