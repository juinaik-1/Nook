import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchQueue, addQueueItem, patchQueueItem, removeQueueItem, clearQueue, advanceQueue } from '../utils/api';
import { fetchVideoMetadata } from '../utils/platforms';

// useQueue keeps a room's playback queue in sync across participants.
// The backend is the source of truth: we fetch on mount (so late joiners get
// the state) and re-fetch whenever a `queue:changed` broadcast arrives.
export function useQueue({ roomId, channel, isConnected, send, canControl, userId }) {
  const [items, setItems] = useState([]);
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const versionRef = useRef(0);
  versionRef.current = version;

  const applyResult = useCallback((result) => {
    if (!result) return;
    if (Array.isArray(result.items)) setItems(result.items);
    if (Number.isFinite(result.version)) {
      setVersion(result.version);
      versionRef.current = result.version;
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!roomId) return;
    try {
      const result = await fetchQueue(roomId);
      applyResult(result);
      setError('');
    } catch (requestError) {
      setError(requestError.message || 'Unable to load the queue.');
    } finally {
      setLoading(false);
    }
  }, [roomId, applyResult]);

  // Initial fetch for late joiners.
  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  // Re-fetch on broadcast change notification.
  useEffect(() => {
    if (!channel) return undefined;
    const handler = () => { void refresh(); };
    channel.on('broadcast', { event: 'queue:changed' }, handler);
    return () => channel.off?.('broadcast', { event: 'queue:changed' }, handler);
  }, [channel, refresh]);

  const notify = useCallback(() => {
    // Broadcast after the REST mutation succeeded, so peers never fetch a
    // state that does not exist yet.
    if (typeof send === 'function') send('queue:changed', { version: versionRef.current });
  }, [send]);

  // Every mutation carries the version the client last saw. If someone else
  // moved the queue in the meantime the server refuses the write (409); the
  // client then re-reads and retries once, so a concurrent edit is never
  // silently lost.
  const runMutation = useCallback(async (mutate) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await mutate(versionRef.current);
      } catch (error) {
        if (error?.status !== 409 || attempt === 1) throw error;
        await refresh();
      }
    }
    return null;
  }, [refresh]);

  const add = useCallback(async (payload) => {
    if (!roomId) return null;
    const enriched = { ...payload };
    if (enriched.url && (!enriched.title || !enriched.thumbnailUrl)) {
      try {
        const meta = await fetchVideoMetadata(enriched.url);
        if (!enriched.title && meta.title) enriched.title = meta.title;
        if (!enriched.author && meta.author) enriched.author = meta.author;
        if (!enriched.thumbnailUrl && meta.thumbnailUrl) enriched.thumbnailUrl = meta.thumbnailUrl;
      } catch {
        /* metadata is best-effort */
      }
    }
    const result = await runMutation(
      (version) => addQueueItem(roomId, { ...enriched, expectedVersion: version }),
    );
    applyResult(result);
    if (result && !result.duplicate) notify();
    return result;
  }, [roomId, applyResult, notify, runMutation]);

  const reorder = useCallback(async (itemId, position) => {
    if (!roomId) return null;
    const result = await runMutation(
      (version) => patchQueueItem(roomId, itemId, { position, expectedVersion: version }),
    );
    applyResult(result);
    notify();
    return result;
  }, [roomId, applyResult, notify, runMutation]);

  const patch = useCallback(async (itemId, payload) => {
    if (!roomId) return null;
    const result = await runMutation(
      (version) => patchQueueItem(roomId, itemId, { ...payload, expectedVersion: version }),
    );
    applyResult(result);
    notify();
    return result;
  }, [roomId, applyResult, notify, runMutation]);

  const remove = useCallback(async (itemId) => {
    if (!roomId) return null;
    const result = await runMutation(
      (version) => removeQueueItem(roomId, itemId, version),
    );
    applyResult(result);
    notify();
    return result;
  }, [roomId, applyResult, notify, runMutation]);

  const clear = useCallback(async () => {
    if (!roomId) return null;
    const result = await runMutation((version) => clearQueue(roomId, version));
    applyResult(result);
    notify();
    return result;
  }, [roomId, applyResult, notify, runMutation]);

  const advance = useCallback(async (finishedItemId) => {
    if (!roomId) return null;
    const result = await runMutation(
      (version) => advanceQueue(roomId, finishedItemId, version),
    );
    applyResult(result);
    if (result?.advanced) notify();
    return result;
  }, [roomId, applyResult, notify, runMutation]);

  return {
    items, version, loading, error,
    refresh, add, reorder, remove, clear, patch, advance,
  };
}