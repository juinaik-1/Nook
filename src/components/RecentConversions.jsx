import { useCallback, useEffect, useState } from 'react';
import { Clock, Film, History, Trash2 } from 'lucide-react';
import { api, fetchMyStreams, fetchMyStorage, clearMyStreams } from '../utils/api';
import { Badge, Button } from './ui';

// How long a converted video is kept by the server. The server owns the
// list, so the countdown only tells the user when to expect it to be gone.
function formatRemaining(expiresAt, now) {
  const remaining = Number(expiresAt || 0) - now;
  if (remaining <= 0) return 'Expiring now';
  const minutes = Math.round(remaining / 60_000);
  if (minutes < 60) return `${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m left`;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

export default function RecentConversions({ onPlay }) {
  const [streams, setStreams] = useState([]);
  const [storage, setStorage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [deleting, setDeleting] = useState('');

  const load = useCallback(async () => {
    try {
      const [streamsResult, storageResult] = await Promise.all([
        fetchMyStreams(),
        fetchMyStorage(),
      ]);
      setStreams(Array.isArray(streamsResult) ? streamsResult : []);
      setStorage(storageResult);
      setError('');
    } catch (requestError) {
      setError(requestError.message || 'Unable to load your recent conversions.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep the countdown honest without refetching the list.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // A conversion can be deleted by the server's cleanup while the room is
  // open, so the list is refreshed now and then.
  useEffect(() => {
    const timer = window.setInterval(() => { void load(); }, 5 * 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const handleDelete = useCallback(async (streamId) => {
    setDeleting(streamId);
    try {
      await api.delete(`/api/streams/${streamId}`);
      await load();
    } catch (requestError) {
      setError(requestError.message || 'Unable to delete the conversion.');
    } finally {
      setDeleting('');
    }
  }, [load]);

  const handleClearAll = useCallback(async () => {
    setDeleting('all');
    try {
      await clearMyStreams();
      await load();
    } catch (requestError) {
      setError(requestError.message || 'Unable to clear conversions.');
    } finally {
      setDeleting('');
    }
  }, [load]);

  if (loading) return null;
  if (error) {
    return (
      <section className="rounded-lg border border-zinc-200/80 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
          <History className="h-4 w-4" />
          <span>{error}</span>
        </div>
      </section>
    );
  }
  if (!streams.length && !storage) return null;

  const usedBytes = storage?.usedBytes || 0;
  const quotaBytes = storage?.quotaBytes || 1;
  const usagePercent = Math.min(100, Math.round((usedBytes / quotaBytes) * 100));
  const overQuota = usedBytes >= quotaBytes;

  return (
    <section className="rounded-lg border border-zinc-200/80 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 shrink-0 text-zinc-500" />
          <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Your recent conversions</h2>
        </div>
        {streams.length > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={handleClearAll}
            disabled={deleting === 'all'}
            title="Delete every converted video you still have"
          >
            {deleting === 'all' ? 'Clearing…' : 'Clear all'}
          </Button>
        ) : null}
      </div>

      {storage ? (
        <div className="mt-2">
          <div className="flex items-center justify-between gap-2 text-2xs text-zinc-500 dark:text-zinc-400">
            <span>
              {formatBytes(usedBytes)} of {formatBytes(quotaBytes)} used
              {storage.reservedBytes > 0 ? ` (${formatBytes(storage.reservedBytes)} reserved)` : ''}
            </span>
            <span>{usagePercent}%</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
            <div
              className={`h-full rounded-full transition-all ${overQuota ? 'bg-red-500' : 'bg-indigo-500'}`}
              style={{ width: `${usagePercent}%` }}
            />
          </div>
        </div>
      ) : null}

      {streams.length ? (
        <ul className="mt-3 flex flex-col gap-2">
          {streams.map((stream) => (
            <li
              key={stream.streamId}
              className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-200/80 px-2.5 py-2 text-xs dark:border-zinc-800"
            >
              <Film className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
              <span className="min-w-0 flex-1 truncate text-zinc-700 dark:text-zinc-200">{stream.name}</span>
              {stream.size ? (
                <Badge tone="neutral" className="shrink-0">
                  {formatBytes(stream.size)}
                </Badge>
              ) : null}
              <Badge tone="neutral" className="shrink-0">
                <Clock className="h-3 w-3" />
                {formatRemaining(stream.expiresAt, now)}
              </Badge>
              <Button size="sm" variant="secondary" onClick={() => onPlay?.(stream)}>
                Play in room
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => handleDelete(stream.streamId)}
                disabled={deleting === stream.streamId}
                title="Delete this converted video"
                aria-label={`Delete ${stream.name}`}
              >
                <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
          No converted videos yet. They appear here after a conversion finishes.
        </p>
      )}
    </section>
  );
}