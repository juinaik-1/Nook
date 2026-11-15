import { useEffect, useState } from 'react';
import { getAlbumSongs, getArtistSongs, searchAlbums, searchArtists, searchSongs } from '../utils/jiosaavn';
import { ArrowLeft, ChevronDown, ChevronUp, Disc3, Film, ListOrdered, Mic2, Music2, Plus, Trash2, X } from 'lucide-react';
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
  const [searchMode, setSearchMode] = useState('songs');
  const [searchResults, setSearchResults] = useState([]);
  const [drilldown, setDrilldown] = useState(null);
  const [showSearch, setShowSearch] = useState(false);
  const [searching, setSearching] = useState(false);
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

  useEffect(() => {
    const trimmed = inputValue.trim();
    if (!trimmed || /^https?:\/\//i.test(trimmed)) {
      setSearchResults([]);
      setShowSearch(false);
      setDrilldown(null);
      return undefined;
    }
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        let results = [];
        if (searchMode === 'artists') results = await searchArtists(trimmed);
        else if (searchMode === 'albums') results = await searchAlbums(trimmed);
        else results = await searchSongs(trimmed);
        setSearchResults(results);
        setDrilldown(null);
        setShowSearch(true);
      } catch {
        setSearchResults([]);
        setDrilldown(null);
        setShowSearch(false);
      } finally {
        setSearching(false);
      }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [inputValue, searchMode]);

  const handleSelectSong = async (song) => {
    setShowSearch(false);
    setInputValue('');
    setSearchResults([]);
    setDrilldown(null);
    setError('');
    setAdding(true);
    try {
      const result = await add({
        kind: 'url',
        url: song.audioUrl,
        title: song.title,
        author: song.artist,
        thumbnailUrl: song.thumbnailUrl,
        type: 'audio',
        status: 'ready',
        addedBy: participantId,
      });
      if (result?.duplicate) setError('This song is already in the queue.');
    } catch (requestError) {
      setError(requestError.message || 'Unable to add to the queue.');
    } finally {
      setAdding(false);
    }
  };

  const handleSelectArtist = async (artist) => {
    setSearching(true);
    try {
      const songs = await getArtistSongs(artist.id, artist.name);
      setDrilldown({ type: 'artist', title: artist.name, songs });
    } catch {
      setError('Unable to load artist songs.');
    } finally {
      setSearching(false);
    }
  };

  const handleSelectAlbum = async (album) => {
    setSearching(true);
    try {
      const songs = await getAlbumSongs(album.id);
      setDrilldown({ type: 'album', title: album.name, songs });
    } catch {
      setError('Unable to load album songs.');
    } finally {
      setSearching(false);
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
        <div className="relative mt-3">
          <div className="mb-2 flex flex-wrap gap-1.5">
            {[
              { id: 'songs', label: 'Songs', Icon: Music2 },
              { id: 'artists', label: 'Artists', Icon: Mic2 },
              { id: 'albums', label: 'Albums', Icon: Disc3 },
            ].map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => { setSearchMode(id); setDrilldown(null); setSearchResults([]); }}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-2xs font-medium transition-colors sm:text-xs',
                  searchMode === id
                    ? 'border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-900/50 dark:bg-indigo-950/30 dark:text-indigo-300'
                    : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800',
                )}
              >
                <Icon className="h-3 w-3 sm:h-3.5 sm:w-3.5" /> {label}
              </button>
            ))}
          </div>
          <form className="flex gap-2" onSubmit={handleAddUrl}>
            <input
              className={cn(inputClass, 'flex-1')}
              value={inputValue}
              onChange={(event) => setInputValue(event.target.value)}
              placeholder={/^https?:\/\//i.test(inputValue.trim()) ? 'Paste a link or search...' : `Paste a link or search ${searchMode}...`}
              aria-label="Queue video URL or search"
              disabled={adding}
            />
            <Button type="submit" size="sm" variant="secondary" disabled={adding || !inputValue.trim()}>
              <Plus className="h-3.5 w-3.5" /> Add
            </Button>
          </form>
          {showSearch ? (
            <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-md border border-zinc-200/80 bg-white shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
              {searching ? (
                <div className="px-3 py-2 text-xs text-zinc-500">Loading…</div>
              ) : null}
              {drilldown ? (
                <>
                  <div className="sticky top-0 flex items-center gap-2 border-b border-zinc-200/80 bg-white px-2 py-2 dark:border-zinc-800 dark:bg-zinc-900">
                    <button type="button" onClick={() => setDrilldown(null)} className="inline-flex items-center gap-1 text-xs text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100">
                      <ArrowLeft className="h-3.5 w-3.5" /> Back
                    </button>
                    <span className="min-w-0 truncate text-xs font-medium text-zinc-700 dark:text-zinc-200">{drilldown.title}</span>
                  </div>
                  {drilldown.songs.length ? drilldown.songs.map((song) => (
                    <button
                      key={song.id}
                      type="button"
                      onClick={() => handleSelectSong(song)}
                      className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    >
                      {song.thumbnailUrl ? (
                        <img src={song.thumbnailUrl} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-9 w-9 shrink-0 rounded object-cover" />
                      ) : (
                        <div className="h-9 w-9 shrink-0 rounded bg-zinc-100 dark:bg-zinc-800" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-zinc-700 dark:text-zinc-200">{song.title}</p>
                        <p className="truncate text-2xs text-zinc-500 dark:text-zinc-400">{song.artist}</p>
                      </div>
                    </button>
                  )) : (
                    <div className="px-3 py-2 text-xs text-zinc-500">No songs found.</div>
                  )}
                </>
              ) : (
                <>
                  {searchMode === 'songs' ? searchResults.map((song) => (
                    <button
                      key={song.id}
                      type="button"
                      onClick={() => handleSelectSong(song)}
                      className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    >
                      {song.thumbnailUrl ? (
                        <img src={song.thumbnailUrl} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-9 w-9 shrink-0 rounded object-cover" />
                      ) : (
                        <div className="h-9 w-9 shrink-0 rounded bg-zinc-100 dark:bg-zinc-800" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-zinc-700 dark:text-zinc-200">{song.title}</p>
                        <p className="truncate text-2xs text-zinc-500 dark:text-zinc-400">{song.artist}</p>
                      </div>
                    </button>
                  )) : null}
                  {searchMode === 'artists' ? searchResults.map((artist) => (
                    <button
                      key={artist.id}
                      type="button"
                      onClick={() => handleSelectArtist(artist)}
                      className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    >
                      {artist.image ? (
                        <img src={artist.image} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-9 w-9 shrink-0 rounded-full object-cover" />
                      ) : (
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-400 dark:bg-zinc-800"><Mic2 className="h-4 w-4" /></div>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-zinc-700 dark:text-zinc-200">{artist.name}</p>
                        <p className="truncate text-2xs text-zinc-500 dark:text-zinc-400">Artist · tap to view songs</p>
                      </div>
                    </button>
                  )) : null}
                  {searchMode === 'albums' ? searchResults.map((album) => (
                    <button
                      key={album.id}
                      type="button"
                      onClick={() => handleSelectAlbum(album)}
                      className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    >
                      {album.image ? (
                        <img src={album.image} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-9 w-9 shrink-0 rounded object-cover" />
                      ) : (
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-zinc-100 text-zinc-400 dark:bg-zinc-800"><Disc3 className="h-4 w-4" /></div>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-zinc-700 dark:text-zinc-200">{album.name}</p>
                        <p className="truncate text-2xs text-zinc-500 dark:text-zinc-400">{album.artist ? `${album.artist} · ` : ''}Album · tap to view songs</p>
                      </div>
                    </button>
                  )) : null}
                  {!searching && !searchResults.length ? (
                    <div className="px-3 py-2 text-xs text-zinc-500">No results.</div>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </div>
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
              className="flex flex-wrap items-center gap-1.5 rounded-md border border-zinc-200/80 px-2 py-1.5 text-xs dark:border-zinc-800 sm:flex-nowrap sm:gap-2 sm:px-2.5 sm:py-2"
            >
              <span className="hidden shrink-0 text-2xs font-medium text-zinc-400 sm:inline">#{index + 1}</span>
              <div className="relative h-8 w-12 flex-shrink-0 overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800 sm:h-9 sm:w-16">
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
                  <Film className="h-4 w-4 sm:h-4 sm:w-4" />
                </div>
              </div>
              <div className="min-w-0 flex-1 basis-24">
                <p
                  className="truncate text-xs font-medium text-zinc-700 dark:text-zinc-200"
                  title={item.title || item.url || ''}
                >
                  {item.title || item.url || item.streamId || 'Queued item'}
                </p>
                <div className="mt-0.5 flex flex-wrap items-center gap-1 sm:gap-1.5">
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
              <div className="flex w-full items-center justify-end gap-1 sm:w-auto sm:shrink-0">
                {canEdit ? (
                  <>
                    <Button size="sm" variant="ghost" className="h-8 w-8 p-0 sm:h-auto sm:w-auto sm:p-1.5" onClick={() => handleMove(item.id, 'up')} disabled={index === 0} aria-label="Move up">
                      <ChevronUp className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" className="h-8 w-8 p-0 sm:h-auto sm:w-auto sm:p-1.5" onClick={() => handleMove(item.id, 'down')} disabled={index === items.length - 1} aria-label="Move down">
                      <ChevronDown className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                    </Button>
                    <Button size="sm" variant="secondary" className="h-8 px-2.5 text-xs sm:h-auto sm:px-3 sm:text-xs" onClick={() => handlePlay(item)} disabled={item.status === 'pending' || item.status === 'failed'}>
                      Play
                    </Button>
                    <Button size="sm" variant="ghost" className="h-8 w-8 p-0 sm:h-auto sm:w-auto sm:p-1.5" onClick={() => handleRemove(item.id)} aria-label="Remove">
                      <Trash2 className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="secondary" className="h-7 px-2 text-2xs sm:h-auto sm:px-3 sm:text-xs" onClick={() => handlePlay(item)} disabled={!canControl || item.status === 'pending' || item.status === 'failed'}>
                    Play
                  </Button>
                )}
              </div>
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