const SESSION_TOKEN_KEY = 'Nook-session-token';
const DEFAULT_API_BASE = 'http://localhost:3001';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function getApiBase() {
  // VITE_API_URL is the documented name; VITE_CONVERT_API_URL is accepted as
  // an alias so existing local setups keep pointing at the right server.
  const configured = import.meta.env.VITE_API_URL || import.meta.env.VITE_CONVERT_API_URL;
  const base = String(configured || DEFAULT_API_BASE).replace(/\/+$/, '');
  if (typeof window === 'undefined') return base;

  // On a local network the API lives on the machine that serves the app. If
  // the configured address is a loopback address but the page was opened
  // through the machine's LAN address, the loopback address would point at
  // the visitor's own device and every API call would fail.
  try {
    const url = new URL(base);
    const pageHost = window.location.hostname;
    if (LOCAL_HOSTS.has(url.hostname.toLowerCase()) && pageHost && !LOCAL_HOSTS.has(pageHost.toLowerCase())) {
      url.hostname = pageHost;
      return url.toString().replace(/\/+$/, '');
    }
  } catch {
    /* keep the configured value */
  }
  return base;
}

export function getSessionToken() {
  return typeof window === 'undefined' ? '' : localStorage.getItem(SESSION_TOKEN_KEY) || '';
}

export function setSessionToken(token) {
  if (typeof window !== 'undefined') {
    if (token) localStorage.setItem(SESSION_TOKEN_KEY, token);
    else localStorage.removeItem(SESSION_TOKEN_KEY);
  }
}

export async function apiFetch(path, options = {}) {
  const { unauthenticated = false, ...fetchOptions } = options;
  const headers = new Headers(fetchOptions.headers || {});
  if (fetchOptions.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const token = !unauthenticated && getSessionToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(`${getApiBase()}${path}`, { ...fetchOptions, headers });
  if (response.status === 401 && !unauthenticated) {
    setSessionToken('');
    window.dispatchEvent(new Event('Nook:unauthorized'));
  }
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text || 'Request failed.' };
  }
  if (!response.ok) {
    const error = new Error(data?.error || data?.message || 'Request failed.');
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

export const api = {
  get: (path) => apiFetch(path),
  post: (path, body) => apiFetch(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  delete: (path) => apiFetch(path, { method: 'DELETE' }),
};

// The converted videos this account still has on the server. The server owns
// the list, so no database is involved.
export function fetchMyStreams() {
  return apiFetch('/api/streams/mine');
}

// Room playback queue.
export function fetchQueue(roomId) {
  return apiFetch(`/api/rooms/${encodeURIComponent(roomId)}/queue`);
}
export function addQueueItem(roomId, payload) {
  return apiFetch(`/api/rooms/${encodeURIComponent(roomId)}/queue`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
export function patchQueueItem(roomId, itemId, payload) {
  return apiFetch(`/api/rooms/${encodeURIComponent(roomId)}/queue/${itemId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}
export function removeQueueItem(roomId, itemId, expectedVersion = null) {
  return apiFetch(`/api/rooms/${encodeURIComponent(roomId)}/queue/${itemId}`, {
    method: 'DELETE',
    body: expectedVersion === null ? undefined : JSON.stringify({ expectedVersion }),
  });
}
export function clearQueue(roomId, expectedVersion = null) {
  return apiFetch(`/api/rooms/${encodeURIComponent(roomId)}/queue`, {
    method: 'DELETE',
    body: expectedVersion === null ? undefined : JSON.stringify({ expectedVersion }),
  });
}
export function advanceQueue(roomId, finishedItemId, expectedVersion = null) {
  return apiFetch(`/api/rooms/${encodeURIComponent(roomId)}/queue/advance`, {
    method: 'POST',
    body: JSON.stringify({ finishedItemId, expectedVersion }),
  });
}


// How much storage this account has used and is allowed to use. The server
// tracks both the files on disk and the space reserved by running jobs.
export function fetchMyStorage() {
  return apiFetch('/api/storage');
}

// Drop every converted video this account still has. The server removes the
// files where it can and reports how much space was freed.
export function clearMyStreams() {
  return apiFetch('/api/streams/mine', { method: 'DELETE' });
}
