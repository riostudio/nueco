import * as FileSystem from 'expo-file-system';

const BASE_URL = process.env.EXPO_PUBLIC_BACKEND_URL;

async function fetchApi(path: string, options?: RequestInit) {
  const url = `${BASE_URL}/api${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API Error ${res.status}: ${text}`);
  }
  return res.json();
}

export const notesApi = {
  getAll: (search?: string) =>
    fetchApi(search ? `/notes?search=${encodeURIComponent(search)}` : '/notes'),
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
};

export const transcribeApi = {
  transcribe: async (fileUri: string): Promise<{ text: string }> => {
    console.log('Transcribing file from URI:', fileUri);
    
    // Determine file extension from URI
    const extension = fileUri.split('.').pop()?.toLowerCase() || 'm4a';
    
    console.log('File extension:', extension);
    console.log('BASE_URL:', BASE_URL);

    try {
      // Read file as base64
      const base64 = await FileSystem.readAsStringAsync(fileUri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      
      console.log('File read successfully, base64 length:', base64.length);
      
      // Send base64 to backend for processing
      const uploadUrl = `${BASE_URL}/api/transcribe-base64`;
      console.log('Uploading to:', uploadUrl);
      
      const response = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
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
    
    const response = await fetch(`${BASE_URL}/api/process-text`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
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
