import * as LegacyFileSystem from 'expo-file-system/legacy';
import { authStorage } from './auth/storage/authStorage';
import { BACKEND_API_BASE_URL, BACKEND_BASE_URL } from './backendBaseUrl';

async function getAuthHeaders(): Promise<Record<string, string>> {
  const accessToken = await authStorage.getAccessToken();
  if (accessToken) {
    return { 'Authorization': `Bearer ${accessToken}` };
  }
  return {};
}

// Single-flight guard: coalesce concurrent token refreshes so only ONE /auth/refresh runs. The
// backend ROTATES refresh tokens, so two concurrent refreshes with the same token make the second
// use an already-invalidated token → "Session expired". (Surfaced once post-login sync moved to the
// background, which makes the notes/events/calendar loads hit refresh concurrently.)
let refreshInFlight: Promise<boolean> | null = null;

function refreshAccessToken(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefreshAccessToken().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

// Refresh the access token using the refresh token
async function doRefreshAccessToken(): Promise<boolean> {
  try {
    const refreshToken = await authStorage.getRefreshToken();
    if (!refreshToken) {
      console.log('No refresh token available');
      return false;
    }

    console.log('Attempting to refresh access token...');
    const response = await fetch(`${BACKEND_API_BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!response.ok) {
      console.error('Token refresh failed:', response.status);
      // Clear tokens if refresh fails - user needs to login again

      return false;
    }

    const result = await response.json();
    await authStorage.setAccessToken(result.access_token);
    if (result.refresh_token) {
      await authStorage.setRefreshToken(result.refresh_token);
    }
    if (result.user) {
      await authStorage.setUser(result.user);
    }
    console.log('Access token refreshed successfully');
    return true;
  } catch (error) {
    console.error('Token refresh error:', error);
    return false;
  }
}

async function fetchApi(path: string, options?: RequestInit, retryCount: number = 0) {
  const url = `${BACKEND_API_BASE_URL}${path}`;
  const authHeaders = await getAuthHeaders();
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
      ...(options?.headers || {}),
    },
  });
  
  // Handle 401 Unauthorized - try to refresh token
  if (res.status === 401 && retryCount < 1) {
    console.log('Got 401, attempting token refresh...');
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      // Retry the request with the new token
      return fetchApi(path, options, retryCount + 1);
    }
    // If refresh failed, throw error with helpful message
    throw new Error('Session expired. Please log in again.');
  }
  
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API Error ${res.status}: ${text}`);
  }
  return res.json();
}

export const notesApi = {
  // Search is client-side (notes are E2EE ciphertext server-side); always fetch all.
  getAll: () => fetchApi('/notes'),
  get: (id: string) => fetchApi(`/notes/${id}`),
  create: (data: any) =>
    fetchApi('/notes', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: any) =>
    fetchApi(`/notes/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id: string) =>
    fetchApi(`/notes/${id}`, { method: 'DELETE' }),
  togglePin: (id: string) =>
    fetchApi(`/notes/${id}/toggle-pin`, { method: 'POST' }),
};

export const eventsApi = {
  getAll: (month?: number, year?: number) =>
    fetchApi(
      month && year ? `/events?month=${month}&year=${year}` : '/events'
    ),
  get: (id: string) => fetchApi(`/events/${id}`),
  create: (data: any) =>
    fetchApi('/events', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: any) =>
    fetchApi(`/events/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id: string) =>
    fetchApi(`/events/${id}`, { method: 'DELETE' }),
  // Batch fetch to fix N+1 query issue
  getBatch: (eventIds: string[]) =>
    fetchApi('/events/batch', { method: 'POST', body: JSON.stringify({ event_ids: eventIds }) }),
};

export const accountApi = {
  // Permanently erase the account + all data (GDPR right to erasure). Requires the password.
  deleteAccount: (password: string) =>
    fetchApi('/account/delete', { method: 'POST', body: JSON.stringify({ password }) }),
};

export const pushApi = {
  register: (token: string, platform: string) =>
    fetchApi('/push/register', { method: 'POST', body: JSON.stringify({ token, platform }) }),
  unregister: (token: string, platform: string) =>
    fetchApi('/push/unregister', { method: 'POST', body: JSON.stringify({ token, platform }) }),
};

export const feedbackApi = {
  submit: (data: {
    sentiment: 'positive' | 'negative';
    tag?: string | null;
    text?: string;
    note_count_at_submission: number;
    app_version: string;
    platform: string;
  }) => fetchApi('/feedback', { method: 'POST', body: JSON.stringify(data) }),
};

// ---- Attachments ----

export interface AttachmentMeta {
  id: string;
  key: string;
  url: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  uploaded_at: string;
}

export const attachmentsApi = {
  presign: (filename: string, mime_type: string, size: number) =>
    fetchApi('/attachments/presign', {
      method: 'POST',
      body: JSON.stringify({ filename, mime_type, size }),
    }),
  remove: (key: string) =>
    fetchApi(`/attachments?key=${encodeURIComponent(key)}`, { method: 'DELETE' }),
  // Presigned GET URL for viewing/downloading (valid ~7 days); used for tap-to-open and share links.
  downloadUrl: (key: string): Promise<{ url: string }> =>
    fetchApi('/attachments/download-url', { method: 'POST', body: JSON.stringify({ key }) }),
};

/**
 * Upload a local file to storage via a presigned POST, returning the metadata to
 * embed in a note. Throws on failure (caller decides how to surface it). Bytes go
 * straight to object storage - never base64-inlined into the note (that caused the
 * AsyncStorage CursorWindow bug).
 */
export type UploadFile = { uri: string; name: string; mimeType: string; size: number };

/**
 * Upload with progress. Uses XMLHttpRequest for the S3 POST because `fetch` can't report
 * upload progress; `onProgress` receives 0..1. Returns the metadata to embed in a note.
 */
export async function uploadAttachmentWithProgress(
  file: UploadFile,
  onProgress?: (fraction: number) => void,
): Promise<AttachmentMeta> {
  const presign = await attachmentsApi.presign(file.name, file.mimeType, file.size);

  const form = new FormData();
  // S3 presigned-POST fields must come before the file part.
  Object.entries(presign.fields as Record<string, string>).forEach(([k, v]) => {
    form.append(k, v);
  });
  // React Native file part shape.
  form.append('file', { uri: file.uri, name: file.name, type: file.mimeType } as any);

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', presign.upload_url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        resolve();
      } else {
        reject(new Error(`Upload failed: ${xhr.status} ${String(xhr.responseText).slice(0, 200)}`));
      }
    };
    xhr.onerror = () => reject(new Error('Upload failed: network error'));
    xhr.send(form);
  });

  return {
    id: presign.id,
    key: presign.key,
    url: presign.file_url,
    filename: file.name,
    mime_type: file.mimeType,
    size_bytes: file.size,
    uploaded_at: new Date().toISOString(),
  };
}

/** Upload without progress (back-compat wrapper). */
export function uploadAttachment(file: UploadFile): Promise<AttachmentMeta> {
  return uploadAttachmentWithProgress(file);
}

export const transcribeApi = {
  transcribe: async (fileUri: string): Promise<{ text: string }> => {
    console.log('Transcribing file from URI:', fileUri);
    
    // Determine file extension from URI
    const extension = fileUri.split('.').pop()?.toLowerCase() || 'm4a';
    
    console.log('File extension:', extension);
    console.log('BACKEND_BASE_URL:', BACKEND_BASE_URL);

    try {
      // Read file as base64 using legacy FileSystem API
      const base64 = await LegacyFileSystem.readAsStringAsync(fileUri, {
        encoding: LegacyFileSystem.EncodingType.Base64,
      });
      
      console.log('File read successfully, base64 length:', base64.length);
      
      // Get auth headers for the request
      const authHeaders = await getAuthHeaders();
      
      // Send base64 to backend for processing
      const uploadUrl = `${BACKEND_API_BASE_URL}/transcribe-base64`;
      console.log('Uploading to:', uploadUrl);
      
      const response = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({
          audio_base64: base64,
          file_extension: extension,
        }),
      });
      
      console.log('Upload response status:', response.status);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error('Transcription error response:', errorText);
        throw new Error(`Transcription failed: ${response.status} - ${errorText}`);
      }
      
      const result = await response.json();
      console.log('Transcription result:', result);
      return result;
    } catch (error) {
      console.error('Transcription upload error:', error);
      throw error;
    }
  },
};

export const textProcessApi = {
  processText: async (text: string, action: 'organize' | 'summarize'): Promise<{ text: string }> => {
    console.log(`Processing text with action: ${action}, length: ${text.length}`);
    
    // Get auth headers for the request
    const authHeaders = await getAuthHeaders();
    
    const response = await fetch(`${BACKEND_API_BASE_URL}/process-text`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify({ text, action }),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Text processing error:', errorText);
      throw new Error(`Text processing failed: ${response.status}`);
    }
    
    const result = await response.json();
    console.log('Text processing result length:', result.text.length);
    return result;
  },
};
