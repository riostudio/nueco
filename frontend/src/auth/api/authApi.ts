import { Platform } from 'react-native';
import * as Device from 'expo-device';
import { User, AuthResponse, MessageResponse, SyncStatus, SignUpData, LoginData, ChangePasswordData } from '../types/auth.types';
import { authStorage } from '../storage/authStorage';
import { BACKEND_API_BASE_URL } from '../../backendBaseUrl';
import { decryptAccountFromServer } from '../../crypto/accountCrypto';

class AuthApiService {
  private async parseJsonResponse<T>(response: Response, context: string): Promise<T> {
    const rawText = await response.text();

    if (!rawText) {
      console.error(`[${context}] Empty response body`, {
        status: response.status,
        contentType: response.headers.get('content-type'),
      });
      throw new Error('Couldn’t reach the server. Have another go in a moment.');
    }

    try {
      return JSON.parse(rawText) as T;
    } catch (parseError) {
      console.error(`[${context}] Failed to parse JSON response`, {
        status: response.status,
        contentType: response.headers.get('content-type'),
        bodyPreview: rawText.substring(0, 500),
        parseError,
      });
      throw new Error('Couldn’t reach the server. Have another go in a moment.');
    }
  }

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

    const result = await this.parseJsonResponse<MessageResponse & { detail?: string }>(response, 'signup');
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

      const result = await this.parseJsonResponse<AuthResponse & { detail?: string }>(response, 'login');
      if (!response.ok) {
        throw new Error(result.detail || 'Login failed');
      }

      // Decrypt before this ever touches local storage - the local cache always holds
      // plaintext, same convention as notes/events (see accountCrypto.ts).
      result.user = await decryptAccountFromServer(result.user);

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
        // Only clear tokens when the server explicitly rejects the refresh token.
        // Do NOT clear on 5xx or network issues - that would wipe valid tokens.
        if (response.status === 401 || response.status === 403) {
          await authStorage.clearAll();
        }
        return null;
      }

      const result = await response.json();
      result.user = await decryptAccountFromServer(result.user);
      await authStorage.setAccessToken(result.access_token);
      await authStorage.setUser(result.user);
      return result;
    } catch {
      // Network error - leave tokens intact so the app can retry when online
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

    const user = await response.json();
    return decryptAccountFromServer(user);
  }

  /** Push the account name to the server. Used for a normal rename, and once by the
   * E2EE key bootstrap (Stage 5) to push the client-encrypted name after the DEK
   * first becomes available - see keySession.ts / AuthContext.tsx. */
  async updateName(name: string, encVersion: number | null = null): Promise<User> {
    const response = await fetch(`${BACKEND_API_BASE_URL}/auth/me`, {
      method: 'PUT',
      headers: await this.getHeaders(true),
      body: JSON.stringify({ name, enc_version: encVersion }),
    });

    const result = await this.parseJsonResponse<User & { detail?: string }>(response, 'updateName');
    if (!response.ok) {
      throw new Error((result as any).detail || 'Failed to update name');
    }
    // If we just pushed a ciphertext name, the raw response echoes it back - re-decrypt
    // for the in-memory/cached copy rather than leaving ciphertext in AuthContext state.
    const decrypted = await decryptAccountFromServer(result);
    await authStorage.setUser(decrypted);
    return decrypted;
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
      // useChangePassword reads error.status to decide whether to show the dedicated "wrong
      // password" message (ChangePasswordScreen checks result.code === 401) - a plain Error
      // here left that branch permanently unreachable, always falling through to the generic
      // error message even on a wrong-password 401.
      const err: any = new Error(result.detail || 'Change password failed');
      err.status = response.status;
      throw err;
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
