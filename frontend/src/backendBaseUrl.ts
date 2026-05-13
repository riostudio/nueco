const DEFAULT_BACKEND_ORIGIN = 'https://note-builder-10.preview.emergentagent.com';

function trimTrailingSlash(url: string): string {
  return url.replace(/\/$/, '');
}

/** Absolute backend origin (scheme + host, no path, no trailing slash). */
export const BACKEND_BASE_URL = trimTrailingSlash(
  process.env.EXPO_PUBLIC_BACKEND_URL?.trim() || DEFAULT_BACKEND_ORIGIN
);

/** Absolute REST API base (`origin` + `/api`, no trailing slash). */
export const BACKEND_API_BASE_URL = `${BACKEND_BASE_URL}/api`;
