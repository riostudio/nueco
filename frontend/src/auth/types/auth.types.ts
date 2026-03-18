export interface User {
  device_id: string;
  device_model: string;
  os_version: string;
  mobile_number: string | null;
  email: string | null;
  auth_provider: 'local' | 'google' | 'facebook' | 'microsoft';
  email_verified: boolean;
  created_at: number;
}

export interface AuthState {
  user: User | null;
  isLoading: boolean;
  error: string | null;
}

export type Result<T> =
  | { success: true; data: T }
  | { success: false; error: string; code: number };

export interface RegisterDeviceRequest {
  device_id: string;
  device_model: string;
  os_version: string;
}

export interface LinkAccountRequest {
  device_id: string;
  email?: string;
  mobile_number?: string;
  password?: string;
}

export interface ChangePasswordRequest {
  device_id: string;
  current_password: string;
  new_password: string;
}
