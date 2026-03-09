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
    const formData = new FormData();
    formData.append('file', {
      uri: fileUri,
      type: 'audio/m4a',
      name: 'recording.m4a',
    } as any);

    const res = await fetch(`${BASE_URL}/api/transcribe`, {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) throw new Error(`Transcription failed: ${res.status}`);
    return res.json();
  },
};
