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
    const mimeType = extension === 'caf' ? 'audio/x-caf' : 
                     extension === 'wav' ? 'audio/wav' :
                     extension === 'webm' ? 'audio/webm' : 'audio/m4a';
    
    console.log('File extension:', extension, 'MIME type:', mimeType);

    try {
      // Use FileSystem.uploadAsync for reliable file upload
      const response = await FileSystem.uploadAsync(
        `${BASE_URL}/api/transcribe`,
        fileUri,
        {
          uploadType: FileSystem.FileSystemUploadType.MULTIPART,
          fieldName: 'file',
          mimeType: mimeType,
          parameters: {},
          headers: {},
        }
      );
      
      console.log('Upload response status:', response.status);
      console.log('Upload response body:', response.body);
      
      if (response.status !== 200) {
        throw new Error(`Transcription failed: ${response.status} - ${response.body}`);
      }
      
      const result = JSON.parse(response.body);
      console.log('Transcription result:', result);
      return result;
    } catch (error) {
      console.error('Transcription upload error:', error);
      throw error;
    }
  },
};
