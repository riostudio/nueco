// Auth API types
export interface User {
  id: string;
  email: string;
  name: string;
  // E2EE (Stage 5): set when `name` is client-side ciphertext. Cleared to null by
  // decryptAccountFromServer once decrypted for in-app use, same convention as notes.
  enc_version?: number | null;
  email_verified: boolean;
  created_at: string;
}

export interface AuthResponse {
  user: User;
  access_token: string;
  refresh_token: string;
  token_type: string;
}

export interface MessageResponse {
  message: string;
  success: boolean;
}

export interface SyncStatus {
  notes_count: number;
  synced: boolean;
  user_name: string;
}

// Request types
export interface SignUpData {
  name: string;
  email: string;
  password: string;
  confirm_password: string;
}

export interface LoginData {
  email: string;
  password: string;
  device_name: string;
  platform: string;
}

export interface ChangePasswordData {
  current_password: string;
  new_password: string;
  confirm_password: string;
}

// Discriminated result for hooks that report success/failure without throwing.
export type Result<T> =
  | { success: true; data: T }
  | { success: false; error: string; code?: number };
