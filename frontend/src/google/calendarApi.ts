/**
 * google/calendarApi.ts
 * Thin REST wrapper over the Google Calendar API v3, called DIRECTLY from the device with the
 * user's own OAuth token (see auth.ts). The Nueco backend is never involved.
 */
import type { GoogleEventResource } from './eventMapper';

const BASE = 'https://www.googleapis.com/calendar/v3';

export class GoogleApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryable: boolean
  ) {
    super(message);
  }
}

async function request<T>(
  token: string,
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch {
    // Network failure - transient.
    throw new GoogleApiError('Network error reaching Google Calendar', 0, true);
  }
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j?.error?.message ?? '';
    } catch {}
    // 401 = token revoked/expired beyond refresh (auth.ts clears tokens on refresh failure);
    // 403/404 = permission/calendar gone; 429/5xx = transient.
    const retryable = res.status === 429 || res.status >= 500;
    throw new GoogleApiError(detail || `Google Calendar API ${res.status}`, res.status, retryable);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface GoogleCalendar {
  id: string;
  summary: string;
  primary?: boolean;
  accessRole?: string;
  timeZone?: string;
  backgroundColor?: string;
}

export async function listCalendars(token: string): Promise<GoogleCalendar[]> {
  const items: GoogleCalendar[] = [];
  let pageToken: string | undefined;
  do {
    const q = new URLSearchParams({ maxResults: '100' });
    if (pageToken) q.set('pageToken', pageToken);
    const page = await request<{ items?: GoogleCalendar[]; nextPageToken?: string }>(
      token,
      `/users/me/calendarList?${q.toString()}`
    );
    items.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  // Only calendars the user can write to are useful for two-way sync.
  return items.filter((c) => c.accessRole === 'owner' || c.accessRole === 'writer');
}

/**
 * Fetch master events (recurring series as ONE item with its RRULE - no instance expansion)
 * in [timeMin, timeMax). Cancelled/deleted items are included (status === 'cancelled') so the
 * caller can mirror deletions conservatively.
 */
export async function listEvents(
  token: string,
  calendarId: string,
  timeMin: string,
  timeMax: string
): Promise<GoogleEventResource[]> {
  const items: GoogleEventResource[] = [];
  let pageToken: string | undefined;
  do {
    const q = new URLSearchParams({
      timeMin,
      timeMax,
      maxResults: '250',
      showDeleted: 'true',
      singleEvents: 'false',
    });
    if (pageToken) q.set('pageToken', pageToken);
    const page = await request<{ items?: GoogleEventResource[]; nextPageToken?: string }>(
      token,
      `/calendars/${encodeURIComponent(calendarId)}/events?${q.toString()}`
    );
    items.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return items;
}

export async function createEvent(
  token: string,
  calendarId: string,
  resource: GoogleEventResource
): Promise<GoogleEventResource> {
  return request<GoogleEventResource>(token, `/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST',
    body: resource,
  });
}

export async function updateEvent(
  token: string,
  calendarId: string,
  eventId: string,
  resource: GoogleEventResource
): Promise<GoogleEventResource> {
  return request<GoogleEventResource>(
    token,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'PUT', body: resource }
  );
}

export async function deleteEvent(
  token: string,
  calendarId: string,
  eventId: string
): Promise<void> {
  await request<void>(
    token,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'DELETE' }
  );
}
