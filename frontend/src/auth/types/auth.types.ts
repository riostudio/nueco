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
  // Daily Brew preferences (backend/auth chunk lands these separately - optional here so
  // DailyBrewCard degrades to "not set" until the fields actually come back from /auth/me).
  news_country?: string | null;
  news_outlet_ids?: string[];
  daily_brew_show_verse?: boolean;
  // Resolved server-side from the daily-brew-enabled PostHog flag (backend/featureflags.py) -
  // never checked from the client, since a device's own ad-blocker/DNS/VPN can hide a
  // client-side PostHog call and there's no way to tell that apart from the flag being off.
  daily_brew_enabled?: boolean;
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
