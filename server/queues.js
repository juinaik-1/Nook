import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';
import { getStream } from './streams.js';

const supabaseUrl = config.supabaseUrl;
const supabaseKey = config.supabaseAnonKey;

// The client is created lazily so a missing Supabase configuration does not
// stop the whole API from booting. The queue endpoints then report the
// problem clearly instead of the server refusing to start.
let client = null;
function getClient() {
  if (!supabaseUrl || !supabaseKey) {
    const error = new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required for the room queue. Add them to server/.env.');
    error.status = 503;
    error.exposeToUser = true;
    throw error;
  }
  if (!client) {
    client = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

const MAX_QUEUE_ITEMS = 50;

export function isValidRoomId(value) {
  return typeof value === 'string' && /^[A-Z0-9]{4,8}$/.test(value);
}

function isValidQueueItem(item) {
  if (!item || typeof item !== 'object') return false;
  if (typeof item.id !== 'string' || !/^[a-f0-9]{32}$/.test(item.id)) return false;
  if (!['url', 'stream', 'job'].includes(item.kind)) return false;
  if (!['ready', 'pending', 'failed'].includes(item.status)) return false;
  if (typeof item.addedBy !== 'string') return false;
  if (!Number.isFinite(item.addedAt)) return false;
  return true;
}

function normalizeState(row) {
  if (!row) return { version: 1, items: [], updatedAt: Date.now() };
  const items = Array.isArray(row.queue_items) ? row.queue_items.filter(isValidQueueItem) : [];
  return {
    version: Number.isFinite(row.version) ? row.version : 1,
    items: items.slice(0, MAX_QUEUE_ITEMS),
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : Date.now(),
  };
}

export async function getQueue(roomCode) {
  const code = String(roomCode || '').toUpperCase();
  const { data, error } = await getClient()
    .from('room_queues')
    .select('queue_items, version, updated_at')
    .eq('room_id', code)
    .maybeSingle();
  if (error) {
    if (/Could not find the table/i.test(error.message)) {
      const missing = new Error("The 'room_queues' table is missing in Supabase. Run supabase_room_queues.sql in the Supabase SQL editor, then restart the server.");
      missing.status = 503;
      missing.exposeToUser = true;
      throw missing;
    }
    throw new Error(`Unable to read queue: ${error.message}`);
  }
  const state = normalizeState(data);
  const pruned = pruneStaleItems(state.items);
  if (pruned.changed) {
    state.items = pruned.items;
    await upsertQueue(code, state);
  }
  return state;
}

// Items that can never play again are dropped instead of being offered:
//   - a converted stream whose file is gone or expired
//   - a conversion that has been pending for too long (the tab was closed)
// The queue keeps its order; only dead entries are removed.
const PENDING_ITEM_TTL_MS = 3 * 60 * 60_000;

function pruneStaleItems(items) {
  let changed = false;
  const now = Date.now();
  const kept = [];
  for (const item of items) {
    if (item.kind === 'stream' && item.streamId) {
      if (!isStreamPlayable(item.streamId)) {
        changed = true;
        continue;
      }
    }
    if (item.status === 'pending' && now - Number(item.addedAt || 0) > PENDING_ITEM_TTL_MS) {
      changed = true;
      continue;
    }
    kept.push(item);
  }
  return { items: kept, changed };
}

// A converted stream is playable while its record exists and has not expired.
function isStreamPlayable(streamId) {
  const record = getStream(streamId);
  return Boolean(record && record.expiresAt > Date.now());
}

async function upsertQueue(roomCode, state) {
  const code = String(roomCode || '').toUpperCase();
  const { error } = await getClient()
    .from('room_queues')
    .upsert({
      room_id: code,
      queue_items: state.items,
      version: state.version,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'room_id' });
  if (error) {
    if (/Could not find the table/i.test(error.message)) {
      const missing = new Error("The 'room_queues' table is missing in Supabase. Run supabase_room_queues.sql in the Supabase SQL editor, then restart the server.");
      missing.status = 503;
      missing.exposeToUser = true;
      throw missing;
    }
    throw new Error(`Unable to save queue: ${error.message}`);
  }
}

// Simple in-memory oEmbed cache (max 200) for backend fallback when the
// client sends no title for YouTube/Vimeo.
const oembedCache = new Map();
const OEMBED_MAX = 200;

function cacheGet(key) { return oembedCache.get(key); }
function cacheSet(key, value) {
  if (oembedCache.size >= OEMBED_MAX) {
    const first = oembedCache.keys().next().value;
    if (first) oembedCache.delete(first);
  }
  oembedCache.set(key, value);
}

function sanitizeThumbnailUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length >= 500) return null;
  if (/^data:/i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return trimmed;
  } catch {
    return null;
  }
}

function derivePlatform(url) {
  if (typeof url !== 'string' || !url.trim()) return 'Link';
  try {
    const host = new URL(url.trim()).hostname.toLowerCase();
    if (host.includes('youtube.com') || host === 'youtu.be') return 'YouTube';
    if (host.includes('vimeo.com')) return 'Vimeo';
    if (host.includes('tiktok.com')) return 'TikTok';
    if (host.includes('x.com') || host.includes('twitter.com')) return 'X / Twitter';
    if (host.includes('instagram.com')) return 'Instagram';
    if (host.includes('reddit.com')) return 'Reddit';
    return host.replace(/^www\\./, '');
  } catch {
    return 'Link';
  }
}

function fallbackTitle(url) {
  if (typeof url !== 'string' || !url.trim()) return 'Queued video';
  try {
    const parsed = new URL(url.trim());
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    // Use the last path segment only when it looks like a real file name
    // (has an extension or is a long slug). Short opaque ids (e.g. Instagram
    // post codes) are not useful as a title, so fall back to the platform name.
    if (last && (last.includes('.') || last.length > 16)) {
      return decodeURIComponent(last).slice(0, 200);
    }
    const platform = derivePlatform(url);
    return platform && platform !== 'Link' ? `${platform} video` : 'Queued video';
  } catch {
    return 'Queued video';
  }
}

async function backendOembed(url) {
  const cached = cacheGet(url);
  if (cached) return cached;
  let endpoint = null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes('youtube.com') || host === 'youtu.be') {
      endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    } else if (host.includes('vimeo.com')) {
      endpoint = `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`;
    }
  } catch { return { title: null, author: null, thumbnailUrl: null }; }
  if (!endpoint) return { title: null, author: null, thumbnailUrl: null };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(endpoint, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return { title: null, author: null, thumbnailUrl: null };
    const data = await res.json();
    const result = {
      title: typeof data?.title === 'string' ? data.title.trim().slice(0, 200) : null,
      author: typeof data?.author_name === 'string' ? data.author_name.trim().slice(0, 200) : null,
      thumbnailUrl: sanitizeThumbnailUrl(data?.thumbnail_url),
    };
    cacheSet(url, result);
    return result;
  } catch {
    return { title: null, author: null, thumbnailUrl: null };
  }
}

// Optimistic concurrency: the client sends the version it last saw. If the
// queue moved on in the meantime the write is refused, so two participants
// editing at once cannot silently overwrite each other.
function assertVersion(state, expectedVersion) {
  if (expectedVersion === undefined || expectedVersion === null || expectedVersion === '') return;
  if (Number(expectedVersion) !== state.version) {
    const error = new Error('The queue changed since you last saw it. Try again.');
    error.status = 409;
    error.conflict = true;
    error.version = state.version;
    throw error;
  }
}

export async function addQueueItem(roomCode, item, expectedVersion = null) {
  const code = String(roomCode || '').toUpperCase();
  const state = await getQueue(code);
  assertVersion(state, expectedVersion);
  if (state.items.length >= MAX_QUEUE_ITEMS) {
    const error = new Error('The queue is full (50 items). Remove one before adding another.');
    error.status = 409;
    throw error;
  }
  // De-duplicate: a given URL or stream may only appear once in the queue.
  const isDuplicate = (existing) => {
    if (item.kind === 'stream' && item.streamId && existing.streamId === item.streamId) return true;
    if ((item.kind === 'url' || item.kind === 'job') && item.url && existing.url === item.url) return true;
    return false;
  };
  const existing = state.items.find(isDuplicate);
  if (existing) {
    return { version: state.version, item: { ...existing }, items: state.items.map((i) => ({ ...i })), duplicate: true };
  }
  const crypto = await import('node:crypto');

  // Resolve metadata: prefer client-provided, fall back to backend oEmbed for
  // YouTube/Vimeo when the client sent no title.
  let title = (typeof item.title === 'string' && item.title.trim()) ? item.title.trim().slice(0, 200) : null;
  let author = (typeof item.author === 'string' && item.author.trim()) ? item.author.trim().slice(0, 200) : null;
  let thumbnailUrl = sanitizeThumbnailUrl(item.thumbnailUrl);
  if (!title && (item.kind === 'url' || item.kind === 'job') && typeof item.url === 'string') {
    const meta = await backendOembed(item.url.trim());
    if (!title && meta.title) title = meta.title;
    if (!author && meta.author) author = meta.author;
    if (!thumbnailUrl && meta.thumbnailUrl) thumbnailUrl = meta.thumbnailUrl;
  }
  if (!title && (item.kind === 'url' || item.kind === 'job') && typeof item.url === 'string') {
    title = fallbackTitle(item.url);
  }

  const record = {
    id: crypto.randomBytes(16).toString('hex'),
    kind: item.kind,
    url: typeof item.url === 'string' ? item.url : null,
    streamId: typeof item.streamId === 'string' ? item.streamId : null,
    jobId: typeof item.jobId === 'string' ? item.jobId : null,
    title,
    author,
    thumbnailUrl,
    platform: derivePlatform(item.url),
    addedBy: item.addedBy,
    addedAt: Date.now(),
    status: item.status || 'ready',
  };
  state.items.push(record);
  state.version += 1;
  state.updatedAt = Date.now();
  await upsertQueue(code, state);
  return { version: state.version, item: record, items: state.items.map((i) => ({ ...i })) };
}

export async function patchQueueItem(roomCode, itemId, patch, expectedVersion = null) {
  const code = String(roomCode || '').toUpperCase();
  const state = await getQueue(code);
  assertVersion(state, expectedVersion);
  const item = state.items.find((entry) => entry.id === itemId);
  if (!item) {
    const error = new Error('Queue item not found.');
    error.status = 404;
    throw error;
  }
  if (patch && typeof patch === 'object') {
    if (typeof patch.title === 'string') item.title = patch.title.slice(0, 200);
    if (typeof patch.author === 'string') item.author = patch.author.slice(0, 200);
    if (patch.thumbnailUrl !== undefined) item.thumbnailUrl = sanitizeThumbnailUrl(patch.thumbnailUrl);
    if (['url', 'stream', 'job'].includes(patch.kind)) item.kind = patch.kind;
    if (['ready', 'pending', 'failed'].includes(patch.status)) item.status = patch.status;
    if (typeof patch.url === 'string') item.url = patch.url;
    if (typeof patch.streamId === 'string') item.streamId = patch.streamId;
    if (typeof patch.jobId === 'string') item.jobId = patch.jobId;
    if (Number.isInteger(patch.position)) {
      const from = state.items.indexOf(item);
      const to = Math.max(0, Math.min(state.items.length - 1, patch.position));
      state.items.splice(from, 1);
      state.items.splice(to, 0, item);
    }
  }
  state.version += 1;
  state.updatedAt = Date.now();
  await upsertQueue(code, state);
  return { version: state.version, item: { ...item }, items: state.items.map((i) => ({ ...i })) };
}

export async function removeQueueItem(roomCode, itemId, expectedVersion = null) {
  const code = String(roomCode || '').toUpperCase();
  const state = await getQueue(code);
  assertVersion(state, expectedVersion);
  const index = state.items.findIndex((entry) => entry.id === itemId);
  if (index < 0) {
    const error = new Error('Queue item not found.');
    error.status = 404;
    throw error;
  }
  const [removed] = state.items.splice(index, 1);
  state.version += 1;
  state.updatedAt = Date.now();
  await upsertQueue(code, state);
  return { version: state.version, removed, items: state.items.map((i) => ({ ...i })) };
}

export async function clearQueue(roomCode, expectedVersion = null) {
  const code = String(roomCode || '').toUpperCase();
  const state = await getQueue(code);
  assertVersion(state, expectedVersion);
  const count = state.items.length;
  state.items = [];
  state.version += 1;
  state.updatedAt = Date.now();
  await upsertQueue(code, state);
  return { version: state.version, cleared: count, items: [] };
}

export async function cleanupExpiredQueues(now = Date.now()) {
  // The same lifetime the converted files use, so one number decides when a
  // room's queue is dropped.
  const ttl = config.orphanFileTtlMs || config.fileTtlMs;
  const cutoff = new Date(now - ttl).toISOString();
  const { error } = await getClient()
    .from('room_queues')
    .delete()
    .lt('updated_at', cutoff);
  if (error) console.error('Queue cleanup failed:', error.message);
  return !error;
}

// Advance the queue after a video finished.
//
// The queue holds the upcoming items; the head is what plays next. The client
// sends the id of the queue item that just finished (or nothing when the video
// that ended was not in the queue). The call is idempotent: the item is only
// removed while it is still the head, so several participants firing the
// fallback at once cannot double-skip.
export async function advanceQueue(roomCode, finishedItemId, expectedVersion = null) {
  const code = String(roomCode || '').toUpperCase();
  const state = await getQueue(code);
  assertVersion(state, expectedVersion);
  const snapshot = () => state.items.map((i) => ({ ...i }));

  // Failed items can never play, so they are dropped first: a failed head
  // would otherwise block the whole queue.
  const beforeFailed = state.items.length;
  state.items = state.items.filter((item) => item.status !== 'failed');
  const droppedFailed = state.items.length !== beforeFailed;

  if (!state.items.length) {
    if (droppedFailed) {
      state.version += 1;
      state.updatedAt = Date.now();
      await upsertQueue(code, state);
    }
    return { advanced: droppedFailed, version: state.version, items: snapshot(), head: null };
  }

  let removed = false;
  if (finishedItemId) {
    const index = state.items.findIndex((item) => item.id === finishedItemId);
    // Someone else already advanced past this item, so nothing is removed.
    if (index >= 0) {
      state.items.splice(index, 1);
      removed = true;
    }
  }

  if (droppedFailed || removed) {
    state.version += 1;
    state.updatedAt = Date.now();
    await upsertQueue(code, state);
  }

  // The head is the first item, including a still-converting one. The room
  // waits for a pending item rather than skipping past it; the conversion
  // handoff starts it when it is ready.
  return {
    advanced: removed || droppedFailed,
    version: state.version,
    items: snapshot(),
    head: state.items[0] || null,
  };
}
