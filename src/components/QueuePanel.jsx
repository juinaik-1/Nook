import { useState } from 'react';
import { ChevronDown, ChevronUp, Film, ListOrdered, Plus, Trash2, X } from 'lucide-react';
import { fetchMyStreams } from '../utils/api';
import { Button, Panel, inputClass } from './ui';
import { cn } from '../utils/cn';
import { normalizeVideoUrl } from '../utils/videoUrl';

import { openConvertTab } from '../utils/roomBridge';
import { isConversionRequired } from '../utils/platforms';

export default function QueuePanel({ queue, canControl, participantId, people = [], roomId, requestId, currentUrl, currentStreamId, currentStreamName, onPlayCurrent }) {
  const { items, loading, error: loadError, add, remove, reorder, clear } = queue;
  // participant id -> the name the room shows for that person.
  const nameById = new Map(people.map((person) => [person.userId, person.name]));
  // Anyone with control may add, reorder, or remove entries, including a guest.
  // Host-only mode still applies: without control nobody may edit the queue.
  const canEdit = Boolean(canControl);
  // The item the room is playing right now, and the one that plays after it.
  const currentIndex = items.findIndex((item) =>
    (currentStreamId && item.streamId === currentStreamId)
    || (currentUrl && item.url === currentUrl),
  );
  const upNextIndex = currentIndex >= 0 ? currentIndex + 1 : 0;
  const [inputValue, setInputValue] = useState('');
  const [adding, setAdding] = useState(false);
  const [myStreams, setMyStreams] = useState([]);
  const [showStreams, setShowStreams] = useState(false);
  const [error, setError] = useState('');

  const handleAddUrl = async (event) => {
    event.preventDefault();
    const normalized = normalizeVideoUrl(inputValue);
    if (!normalized) {
      setError('Enter an HTTP or HTTPS video URL.');
      return;
    }
    setError('');
    setAdding(true);
    try {
      if (isConversionRequired(normalized)) {
        // Link-only platform: create a pending job item and open a conversion
        // tab in the background. The item upgrades to ready when it finishes.
        const jobResult = await add({ kind: 'job', url: normalized, title: null, status: 'pending', addedBy: participantId });
        if (jobResult?.duplicate) { setError('This link is already in the queue.'); return; }
        openConvertTab({ roomId, requestId, url: normalized, auto: true });
        setInputValue('');
      } else {
        const result = await add({ kind: 'url', url: normalized, title: null, status: 'ready', addedBy: participantId });
        if (result?.duplicate) setError('This link is already in the queue.');
        else setInputValue('');
      }
    } catch (requestError) {
      setError(requestError.message || 'Unable to add to the queue.');
    } finally {
      setAdding(false);
    }
  };

  const loadMyStreams = async () => {
    try {
      const result = await fetchMyStreams();
      setMyStreams(Array.isArray(result) ? result : []);
      setShowStreams(true);
    } catch (requestError) {
      setError(requestError.message || 'Unable to load your conversions.');
    }
  };

  const handleAddStream = async (stream) => {
    setAdding(true);
    setError('');
    try {
      await add({ kind: 'stream', streamId: stream.streamId, title: stream.name, status: 'ready', addedBy: participantId });
      setShowStreams(false);
    } catch (requestError) {
      setError(requestError.message || 'Unable to add to the queue.');
    } finally {
      setAdding(false);
    }
  };

  const handleMove = async (itemId, direction) => {
    const index = items.findIndex((item) => item.id === itemId);
    if (index < 0) return;
    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= items.length) return;
    try {
      await reorder(itemId, target);
    } catch (requestError) {
      setError(requestError.message || 'Unable to reorder.');
    }
  };

  const handleRemove = async (itemId) => {
    try {
      await remove(itemId);
    } catch (requestError) {
      setError(requestError.message || 'Unable to remove.');
    }
  };

  const handleClear = async () => {
    try {
      await clear();
    } catch (requestError) {
      setError(requestError.message || 'Unable to clear.');
    }
  };

  const handlePlay = (item) => {
    if (!item || item.status === 'pending' || item.status === 'failed') return;
    onPlayCurrent?.(item);
  };

  if (loading) {
    return (
      <Panel className="p-3">
        <p className="text-xs text-zinc-500 dark:text-zinc-400">Loading queue…</p>
      </Panel>
    );
  }

  return (
    <Panel className="p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ListOrdered className="h-4 w-4 shrink-0 text-zinc-500" />
          <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Up next</h2>
          <span className="text-2xs text-zinc-400">{items.length} item{items.length === 1 ? '' : 's'}</span>
        </div>
        {canEdit && items.length > 0 ? (
          <Button size="sm" variant="ghost" onClick={handleClear} title="Clear the queue">
            Clear
          </Button>
        ) : null}
      </div>

      {loadError ? (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">
          Queue unavailable: {loadError}
        </p>
      ) : null}
      {error ? (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>
      ) : null}

      {canEdit ? (
        <form className="mt-3 flex gap-2" onSubmit={handleAddUrl}>
          <input
            className={cn(inputClass, 'flex-1')}
            value={inputValue}
            onChange={(event) => setInputValue(event.target.value)}
            placeholder="Paste a video URL to queue"
            aria-label="Queue video URL"
            disabled={adding}
          />
          <Button type="submit" size="sm" variant="secondary" disabled={adding || !inputValue.trim()}>
            <Plus className="h-3.5 w-3.5" /> Add
          </Button>
        </form>
      ) : null}

      {canEdit ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {currentUrl || currentStreamId ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={adding}
              onClick={async () => {
                setAdding(true);
                setError('');
                try {
                  let result;
                  if (currentStreamId) {
                    result = await add({ kind: 'stream', streamId: currentStreamId, title: currentStreamName || 'Current video', status: 'ready', addedBy: participantId });
                  } else {
                    result = await add({ kind: 'url', url: currentUrl, title: null, status: 'ready', addedBy: participantId });
                  }
                  if (result?.duplicate) setError('This video is already in the queue.');
                } catch (requestError) {
                  setError(requestError.message || 'Unable to add to the queue.');
                } finally {
                  setAdding(false);
                }
              }}
            >
              Add current video
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={loadMyStreams} disabled={adding}>
            From my conversions
          </Button>
        </div>
      ) : null}

      {showStreams ? (
        <div className="mt-2 max-h-40 overflow-y-auto rounded-md border border-zinc-200/80 p-2 dark:border-zinc-800">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-2xs font-medium uppercase tracking-wide text-zinc-400">Your conversions</span>
            <button type="button" onClick={() => setShowStreams(false)} className="text-zinc-400 hover:text-zinc-600">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {myStreams.length ? (
            <ul className="flex flex-col gap-1">
              {myStreams.map((stream) => (
                <li key={stream.streamId} className="flex items-center justify-between gap-2 text-xs">
                  <span className="min-w-0 flex-1 truncate">{stream.name}</span>
                  <Button size="sm" variant="secondary" onClick={() => handleAddStream(stream)} disabled={adding}>
                    Queue
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">No converted videos yet.</p>
          )}
        </div>
      ) : null}

      {items.length ? (
        <ol className="mt-3 flex flex-col gap-2">
          {items.map((item, index) => (
            <li
              key={item.id}
              className="flex items-center gap-2 rounded-md border border-zinc-200/80 px-2.5 py-2 text-xs dark:border-zinc-800"
            >
              <span className="shrink-0 text-2xs font-medium text-zinc-400">#{index + 1}</span>
              <div className="relative h-9 w-16 flex-shrink-0 overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800">
                {item.thumbnailUrl ? (
                  <img
                    src={item.thumbnailUrl}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className="h-full w-full object-cover"
                    onError={(e) => { e.currentTarget.style.display = 'none'; }}
                  />
                ) : null}
                <div className="absolute inset-0 flex items-center justify-center text-zinc-400">
                  <Film className="h-4 w-4" />
                </div>
              </div>
              <div className="min-w-0 flex-1">
                <p
                  className="truncate text-xs font-medium text-zinc-700 dark:text-zinc-200"
                  title={item.title || item.url || ''}
                >
                  {item.title || item.url || item.streamId || 'Queued item'}
                </p>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                  {(() => {
                    const isCurrent = (currentStreamId && item.streamId === currentStreamId)
                      || (currentUrl && item.url === currentUrl);
                    if (isCurrent) {
                      return (
                        <span className="shrink-0 rounded bg-indigo-100 px-1.5 py-0.5 text-2xs font-medium text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
                          Now playing
                        </span>
                      );
                    }
                    if (index === upNextIndex) {
                      return (
                        <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-2xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                          Up next
                        </span>
                      );
                    }
                    return null;
                  })()}
                  {item.author ? (
                    <span className="truncate text-2xs text-zinc-500 dark:text-zinc-400">{item.author}</span>
                  ) : (
                    <span className="text-2xs text-zinc-400">{item.platform}</span>
                  )}
                  <span className="shrink-0 text-2xs text-zinc-400 dark:text-zinc-500">
                    {item.addedBy === participantId
                      ? 'You'
                      : nameById.get(item.addedBy) || 'Guest'}
                  </span>
                  {item.status === 'pending' ? (
                    <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-2xs font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                      Converting…
                    </span>
                  ) : null}
                  {item.status === 'failed' ? (
                    <span className="shrink-0 rounded bg-red-100 px-1.5 py-0.5 text-2xs font-medium text-red-700 dark:bg-red-900/40 dark:text-red-300">
                      Failed
                    </span>
                  ) : null}
                </div>
              </div>
              {canEdit ? (
                <>
                  <Button size="sm" variant="ghost" onClick={() => handleMove(item.id, 'up')} disabled={index === 0} aria-label="Move up">
                    <ChevronUp className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => handleMove(item.id, 'down')} disabled={index === items.length - 1} aria-label="Move down">
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => handlePlay(item)} disabled={item.status === 'pending' || item.status === 'failed'}>
                    Play
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => handleRemove(item.id)} aria-label="Remove">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="secondary" onClick={() => handlePlay(item)} disabled={!canControl || item.status === 'pending' || item.status === 'failed'}>
                  Play
                </Button>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
          Nothing queued. Add a URL or one of your conversions to line up what plays next.
        </p>
      )}
    </Panel>
  );
}