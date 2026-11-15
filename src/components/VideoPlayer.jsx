import { useCallback, useEffect, useRef, useState } from 'react';
import ReactPlayer from 'react-player';
import { Clock, Link2, MonitorPlay, Pause, Play, Radio, VolumeX, WandSparkles } from 'lucide-react';
import { Badge, Button, Panel, inputClass } from './ui';
import { normalizeVideoUrl } from '../utils/videoUrl';
import { isConversionRequired, isEmbeddable, matchPlatform, platformLabel } from '../utils/platforms';
import { cn } from '../utils/cn';

function formatDuration(value) {
  const total = Number(value);
  if (!Number.isFinite(total) || total <= 0) return '';
  const seconds = String(Math.floor(total % 60)).padStart(2, '0');
  const minutes = Math.floor((total / 60) % 60);
  const hours = Math.floor(total / 3600);
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

function formatTimestamp(value) {
  const total = Number(value);
  if (!Number.isFinite(total) || total < 0) return '0:00';
  const seconds = String(Math.floor(total % 60)).padStart(2, '0');
  const minutes = Math.floor((total / 60) % 60);
  const hours = Math.floor(total / 3600);
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

export default function VideoPlayer({
  url, streamId, streamName, mediaItem = null, playing, time, roomTime, duration = 0, canControl, canConvert = true,
  loading, error, syncNonce = 0, onPlayPause, onSeek, onProgress, onDuration, onLoadVideo, onVideoError, onReady,
  onConvert, onQueueAdd, onPlayNext, onEnded, hasQueueItems = false,
  isTheaterMode = false, onToggleTheater, theaterToast = null,
}) {
  const playerRef = useRef(null);
  const [inputValue, setInputValue] = useState('');
  const [localError, setLocalError] = useState('');
  const [theaterControlsVisible, setTheaterControlsVisible] = useState(true);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [activated, setActivated] = useState(false);
  const [playerMuted, setPlayerMuted] = useState(true);
  const [mutedForUrl, setMutedForUrl] = useState(url);
  const playingRef = useRef(false);
  // The engine calls play() and pause() itself, and the browser reports those
  // as play and pause events as well. The event can arrive after the room
  // state has already changed, so each call is marked separately and the
  // matching event consumes the mark. Reporting one as a user action would
  // make the room start or stop playing on its own.
  const programmaticPlayAtRef = useRef(0);
  const programmaticPauseAtRef = useRef(0);
  const markProgrammaticPlay = useCallback(() => {
    programmaticPlayAtRef.current = Date.now();
  }, []);
  const markProgrammaticPause = useCallback(() => {
    programmaticPauseAtRef.current = Date.now();
  }, []);
  const consumeProgrammaticEvent = useCallback((kind) => {
    const ref = kind === 'play' ? programmaticPlayAtRef : programmaticPauseAtRef;
    const markedAt = ref.current;
    if (!markedAt) return false;
    ref.current = 0;
    // The engine's call never produced an event (blocked autoplay), so the
    // mark is stale and must not swallow a later user action.
    return Date.now() - markedAt < 2000;
  }, []);
  // True while a seek we performed ourselves is in flight, so the resulting
  // seek event is recognised as an echo rather than a user scrub.
  const programmaticSeekRef = useRef(null);
  const programmaticSeekTimerRef = useRef(0);
  const isStream = Boolean(streamId);
  const isDriveMedia = Boolean(url && /^https:\/\/drive\.google\.com\/uc\?/.test(url));
  const useNativePlayer = isStream || isDriveMedia;
  const isAudio = Boolean(
    (mediaItem && (mediaItem.type === 'audio' || String(mediaItem.url || '').endsWith('.mp4'))) ||
    (url && String(url).endsWith('.mp4')),
  );
  const audioThumb = mediaItem?.thumbnailUrl || '';
  const audioTitle = mediaItem?.title || streamName || '';
  const audioArtist = mediaItem?.author || '';

  // Reset the mute state during render so a newly mounted player is created
  // muted from the very first paint (the embedded player only reads `muted` at
  // load time).
  if (mutedForUrl !== url) {
    setMutedForUrl(url);
    setPlayerMuted(true);
  }

  useEffect(() => {
    const markActivated = () => setActivated(true);
    window.addEventListener('pointerdown', markActivated);
    window.addEventListener('keydown', markActivated);
    return () => {
      window.removeEventListener('pointerdown', markActivated);
      window.removeEventListener('keydown', markActivated);
    };
  }, []);

  // Restore audio once playback is running and the page has a gesture.
  useEffect(() => {
    if (activated && playingRef.current) setPlayerMuted(false);
  }, [activated]);

  useEffect(() => {
    setInputValue('');
    setAutoplayBlocked(false);
    setLocalError('');
    playingRef.current = false;
    programmaticSeekRef.current = null;
  }, [streamId, url]);

  // ReactPlayer exposes a different object per provider: a DOM <video> for file/direct
  // URLs, a YT.Player for YouTube, and the Vimeo Player SDK instance for Vimeo. The
  // native renderer is the element itself. Resolve whichever object backs the source.
  const getPlayer = useCallback(() => {
    const ref = playerRef.current;
    if (!ref) return null;
    if (typeof ref.getInternalPlayer === 'function') {
      try { return ref.getInternalPlayer(); } catch { return null; }
    }
    return ref;
  }, []);

  // ReactPlayer only applies `playing` through the HTML autoPlay attribute, so it never
  // re-triggers playback when the value is already true. Reconcile the underlying player
  // directly on every sync message (syncNonce) instead of relying on the boolean changing.
  const syncPlayback = useCallback(() => {
    const player = getPlayer();
    if (!player) return;
    if (typeof player.playVideo === 'function') {
      // YouTube (YT.Player)
      if (playing) {
        markProgrammaticPlay();
        player.playVideo();
      } else if (typeof player.pauseVideo === 'function') {
        markProgrammaticPause();
        player.pauseVideo();
      }
      return;
    }
    if (typeof player.setCurrentTime === 'function' && typeof player.play === 'function') {
      // Vimeo (Player SDK)
      if (playing) markProgrammaticPlay();
      else markProgrammaticPause();
      const result = playing ? player.play() : player.pause();
      if (result?.catch) result.catch(() => setAutoplayBlocked(true));
      return;
    }
    if (typeof player.play === 'function') {
      // HTML5 <video>/<audio>
      if (playing && player.paused) {
        markProgrammaticPlay();
        const playResult = player.play();
        if (playResult?.catch) {
          playResult.catch(() => {
            try { player.muted = true; } catch { /* ignore */ }
            markProgrammaticPlay();
            const mutedResult = player.play();
            if (mutedResult?.catch) mutedResult.catch(() => setAutoplayBlocked(true));
          });
        }
      } else if (!playing && !player.paused) {
        markProgrammaticPause();
        player.pause();
      }
    }
  }, [getPlayer, markProgrammaticPause, markProgrammaticPlay, playing]);

  // The player reports every seek through one event, whether the user dragged
  // the scrub bar or the sync engine moved it. Record the position we seek to
  // ourselves so the hook can tell a deliberate seek from an echo.
  const markProgrammaticSeek = useCallback((target) => {
    programmaticSeekRef.current = { time: Number(target), at: Date.now() };
    window.clearTimeout(programmaticSeekTimerRef.current);
    programmaticSeekTimerRef.current = window.setTimeout(() => {
      programmaticSeekRef.current = null;
    }, 3000);
  }, []);

  const syncTime = useCallback(() => {
    if (!Number.isFinite(time)) return;
    const player = getPlayer();
    if (!player) return;
    if (typeof player.playVideo === 'function' && typeof player.seekTo === 'function') {
      // YouTube (YT.Player)
      const current = Number(player.getCurrentTime?.());
      if (!Number.isFinite(current) || Math.abs(current - time) > 1) {
        markProgrammaticSeek(time);
        player.seekTo(time, true);
      }
      return;
    }
    if (typeof player.setCurrentTime === 'function') {
      // Vimeo (Player SDK) — getCurrentTime/setCurrentTime are async
      Promise.resolve(typeof player.getCurrentTime === 'function' ? player.getCurrentTime() : 0)
        .then((current) => {
          if (Math.abs((Number(current) || 0) - time) > 1) {
            markProgrammaticSeek(time);
            player.setCurrentTime(time);
          }
        })
        .catch(() => {});
      return;
    }
    if (typeof player.currentTime === 'number') {
      // HTML5 <video>/<audio>
      if (Math.abs((player.currentTime || 0) - time) > 1) {
        markProgrammaticSeek(time);
        player.currentTime = time;
      }
    }
  }, [getPlayer, markProgrammaticSeek, time]);

  useEffect(() => {
    if (!url) return;
    syncPlayback();
  }, [syncPlayback, url, streamId, syncNonce]);

  useEffect(() => {
    if (!url) return;
    syncTime();
  }, [syncTime, url, streamId, syncNonce]);

  // YouTube/Vimeo don't reject play() when the browser blocks autoplay, and a
  // native player can resolve without starting, so probe the player state
  // shortly after a sync to surface the same "Click to start" fallback.
  //
  // The probe must not leave the button on screen: a viewer without control
  // cannot start anything, and a player that starts late would keep the
  // button up. The state is polled until the player actually runs, and the
  // button is only ever shown to someone who can act on it.
  useEffect(() => {
    if (!url || !playing || !canControl) return undefined;
    const player = getPlayer();
    const isYouTube = typeof player?.getPlayerState === 'function' && typeof player?.playVideo === 'function';
    const isVimeo = !isYouTube && typeof player?.getPaused === 'function';
    const isHtml5 = !isYouTube && !isVimeo && typeof player?.play === 'function';
    if (!isYouTube && !isVimeo && !isHtml5) return undefined;

    const clearIfRunning = () => {
      setAutoplayBlocked(false);
      window.clearInterval(timer);
    };

    let checks = 0;
    const timer = window.setInterval(() => {
      checks += 1;
      try {
        if (isYouTube) {
          const state = player.getPlayerState();
          // 1 = playing, 3 = buffering.
          if (state === 1 || state === 3) {
            clearIfRunning();
            return;
          }
        } else if (isVimeo) {
          Promise.resolve(player.getPaused()).then((paused) => {
            if (!paused) clearIfRunning();
          }).catch(() => {});
        } else if (player && !player.paused) {
          clearIfRunning();
          return;
        }
      } catch { /* ignore */ }
      // After a second and a half the player is not running, so offer the
      // manual start. The offer stays until the player actually runs, so a
      // failed manual start can be retried and the button never lingers
      // over a video that is playing on its own.
      if (checks >= 6) setAutoplayBlocked(true);
    }, 500);
    return () => window.clearInterval(timer);
  }, [getPlayer, url, playing, syncNonce, canControl]);

  // The fallback is only meaningful while the room wants playback. Once the
  // room is paused the button would linger over a video nobody is watching.
  useEffect(() => {
    if (!playing) setAutoplayBlocked(false);
  }, [playing]);

  // A viewer without control can never start the video themselves, so the
  // button is hidden for them.
  const showAutoplayBlocked = autoplayBlocked && canControl && playing;

  const reassertRoomState = useCallback(() => {
    syncPlayback();
    syncTime();
  }, [syncPlayback, syncTime]);

  const reportSeek = useCallback((seconds) => {
    const value = Number(seconds);
    if (!Number.isFinite(value)) return;
    // The seek is an echo when it matches a position the sync engine just
    // applied. A user scrub to a different position is always authoritative.
    const pending = programmaticSeekRef.current;
    const isEcho = Boolean(pending)
      && Math.abs(value - pending.time) < 1
      && Date.now() - pending.at < 3000;
    if (isEcho) {
      programmaticSeekRef.current = null;
      window.clearTimeout(programmaticSeekTimerRef.current);
      onSeek?.(value, { userInitiated: false });
      return;
    }
    onSeek?.(value, { userInitiated: true });
  }, [onSeek]);

  const submit = (event) => {
    event.preventDefault();
    const trimmed = inputValue.trim();
    // No link entered: act as "Play next" - advance to the next queued item.
    if (!trimmed) {
      if (hasQueueItems && (url || streamId) && typeof onPlayNext === 'function') onPlayNext();
      return;
    }
    const normalized = normalizeVideoUrl(trimmed);
    if (!normalized) {
      setLocalError('Enter a valid video URL. ');
      return;
    }
    setLocalError('');
    const needsConversion = isConversionRequired(normalized);
    // Guests cannot queue conversion-requiring links (no account to run the job).
    if (needsConversion && !canConvert) {
      setLocalError('Sign in to convert and queue this platform.');
      return;
    }
    // When a video is already playing with more than a few seconds left, queue
    // the new link instead of replacing the current playback. Otherwise (no
    // video, ended, or near the end) load it directly.
    const hasCurrent = Boolean(url || streamId);
    const nearEnd = Boolean(duration && duration > 0 && (duration - (roomTime || 0)) <= 5);
    const shouldQueue = hasCurrent && playing && !nearEnd && typeof onQueueAdd === 'function';
    if (shouldQueue) {
      onQueueAdd(normalized);
      setInputValue('');
      return;
    }
    if (isConversionRequired(normalized)) {
      // Link-only platform: hand the URL to the Convert tab instead of
      // trying to play it directly. The room keeps playing.
      onConvert?.({ url: normalized });
      return;
    }
    onLoadVideo?.(normalized);
    setInputValue('');
  };
  const handleUnmute = useCallback(() => {
    setActivated(true);
    setPlayerMuted(false);
    const player = getPlayer();
    if (!player) return;
    try {
      if (typeof player.unmute === 'function') player.unmute();
      else if ('muted' in player) player.muted = false;
    } catch { /* ignore */ }
  }, [getPlayer]);

  const durationLabel = formatDuration(duration);
  const positionLabel = formatTimestamp(roomTime);
  const showUnmute = playerMuted && playing && url;

  useEffect(() => {
    if (isTheaterMode && typeof window !== 'undefined' && window.innerWidth < 640) {
      onToggleTheater?.();
    }
  }, [isTheaterMode, onToggleTheater]);

  useEffect(() => {
    if (isAudio && isTheaterMode) onToggleTheater?.();
  }, [isAudio, isTheaterMode, onToggleTheater]);

  useEffect(() => {
    if (!isTheaterMode) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onToggleTheater?.();
      if (e.key === 'ArrowRight') { e.preventDefault(); onSeek?.((time || 0) + 10); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); onSeek?.(Math.max(0, (time || 0) - 10)); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isTheaterMode, onToggleTheater, time, onSeek]);

  useEffect(() => {
    if (!isTheaterMode) return undefined;
    let timer;
    const show = () => {
      setTheaterControlsVisible(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setTheaterControlsVisible(false), 3000);
    };
    show();
    window.addEventListener('mousemove', show);
    return () => {
      window.removeEventListener('mousemove', show);
      window.clearTimeout(timer);
    };
  }, [isTheaterMode]);

  return (
    <div className={isTheaterMode ? 'fixed inset-0 w-screen h-screen z-50 bg-black flex flex-col items-center justify-center' : 'flex flex-col gap-3'}>
      <Panel className="overflow-hidden">
        <div className={isTheaterMode ? 'relative w-screen h-screen overflow-hidden bg-black' : 'relative aspect-video w-full overflow-hidden bg-zinc-950'}>
          <div className={cn('absolute inset-0', !canControl && 'pointer-events-none')}>
          {url ? (isAudio ? (
            <>
              <audio
                key={url}
                ref={playerRef}
                src={url}
                controls={canControl}
                preload="metadata"
                muted={playerMuted}
                className="hidden"
                onLoadedMetadata={(event) => {
                  if (time > 0) event.currentTarget.currentTime = time;
                  onReady?.({ autoplay: false });
                  syncPlayback();
                  syncTime();
                }}
                onPlay={(event) => {
                  playingRef.current = true;
                  if (activated) {
                    event.currentTarget.muted = false;
                    setPlayerMuted(false);
                  }
                  if (consumeProgrammaticEvent('play')) return;
                  if (playing) return;
                  if (!canControl) {
                    markProgrammaticPause();
                    event.currentTarget.pause();
                    return;
                  }
                  setAutoplayBlocked(false);
                  setLocalError('');
                  onPlayPause?.(true);
                }}
                onPause={() => {
                  playingRef.current = false;
                  if (!playing) return;
                  if (!canControl) {
                    reassertRoomState();
                    return;
                  }
                  onPlayPause?.(false);
                }}
                onEnded={() => (onEnded ? onEnded() : onPlayPause?.(false))}
                onTimeUpdate={(event) => onProgress?.(event.currentTarget.currentTime)}
                onDurationChange={(event) => onDuration?.(event.currentTarget.duration)}
                onSeeked={(event) => {
                  if (!canControl) {
                    reassertRoomState();
                    return;
                  }
                  reportSeek(event.currentTarget.currentTime);
                }}
                onError={(event) => {
                  const message = event.currentTarget.error?.code
                    ? `This audio failed to load (media error ${event.currentTarget.error.code}).`
                    : 'This audio failed to load.';
                  setLocalError(message);
                  onVideoError?.(message);
                }}
              />
              <div className="absolute inset-0">
                {audioThumb ? (
                  <img
                    src={audioThumb}
                    alt=""
                    aria-hidden="true"
                    className="absolute inset-0 h-full w-full scale-125 object-cover blur-3xl opacity-40"
                  />
                ) : null}
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 pb-16 pt-3 text-center sm:gap-4 sm:px-6 sm:pb-4">
                  {audioThumb ? (
                    <img
                      src={audioThumb}
                      alt={audioTitle}
                      className="h-24 w-24 rounded-2xl object-cover shadow-2xl sm:h-48 sm:w-48"
                    />
                  ) : null}
                  <div>
                    <p className="text-lg font-semibold text-zinc-100 sm:text-xl">{audioTitle}</p>
                    {audioArtist ? <p className="text-sm text-zinc-400">{audioArtist}</p> : null}
                  </div>
                  {canControl ? (
                    <div className="hidden sm:flex flex-col gap-3 w-full max-w-md mx-auto">
                      <div className="flex items-center justify-center">
                        <button
                          type="button"
                          onClick={() => onPlayPause?.(!playing)}
                          aria-label={playing ? 'Pause' : 'Play'}
                          className="w-12 h-12 flex items-center justify-center rounded-full bg-white text-black hover:bg-gray-200 transition-colors"
                        >
                          {playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
                        </button>
                      </div>
                      <div className="flex items-center gap-3 w-full group">
                        <span className="text-xs font-medium text-zinc-400 tabular-nums">{formatTimestamp(roomTime)}</span>
                        <div className="relative flex-1 h-1 rounded-full bg-zinc-700">
                          <div
                            className="absolute left-0 top-0 h-1 rounded-full bg-white"
                            style={{ width: `${duration ? Math.min(100, (Number(roomTime || 0) / duration) * 100) : 0}%` }}
                          />
                          <input
                            type="range"
                            min={0}
                            max={duration || 0}
                            step={0.1}
                            value={Number.isFinite(roomTime) ? roomTime : 0}
                            onChange={(event) => onSeek?.(Number(event.target.value), { userInitiated: true })}
                            className="absolute inset-0 w-full h-1 opacity-0 cursor-pointer"
                            aria-label="Seek"
                          />
                          <div
                            className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-white shadow-md scale-0 group-hover:scale-100 group-focus-within:scale-100 transition-transform pointer-events-none"
                            style={{ left: `calc(${duration ? Math.min(100, (Number(roomTime || 0) / duration) * 100) : 0}% - 6px)` }}
                          />
                        </div>
                        <span className="text-xs font-medium text-zinc-400 tabular-nums">{formatDuration(duration) || '--:--'}</span>
                      </div>
                    </div>
                  ) : null}
                </div>
                {canControl ? (
                  <div className="sm:hidden absolute bottom-0 left-0 right-0 flex items-center gap-3 bg-black/60 px-3 py-2 backdrop-blur">
                    <button
                      type="button"
                      onClick={() => onPlayPause?.(!playing)}
                      aria-label={playing ? 'Pause' : 'Play'}
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-black hover:bg-gray-200 transition-colors"
                    >
                      {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                    </button>
                    <div className="flex min-w-0 flex-1 items-center gap-2 group">
                      <span className="text-xs font-medium text-zinc-300 tabular-nums">{formatTimestamp(roomTime)}</span>
                      <div className="relative flex-1 h-1 rounded-full bg-zinc-600">
                        <div
                          className="absolute left-0 top-0 h-1 rounded-full bg-white"
                          style={{ width: `${duration ? Math.min(100, (Number(roomTime || 0) / duration) * 100) : 0}%` }}
                        />
                        <input
                          type="range"
                          min={0}
                          max={duration || 0}
                          step={0.1}
                          value={Number.isFinite(roomTime) ? roomTime : 0}
                          onChange={(event) => onSeek?.(Number(event.target.value), { userInitiated: true })}
                          className="absolute inset-0 w-full h-1 opacity-0 cursor-pointer"
                          aria-label="Seek"
                        />
                        <div
                          className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-white shadow-md scale-100 transition-transform pointer-events-none"
                          style={{ left: `calc(${duration ? Math.min(100, (Number(roomTime || 0) / duration) * 100) : 0}% - 6px)` }}
                        />
                      </div>
                      <span className="text-xs font-medium text-zinc-300 tabular-nums">{formatDuration(duration) || '--:--'}</span>
                    </div>
                  </div>
                ) : null}
              </div>
            </>
          ) : (useNativePlayer ? (
            <>
              <video
                key={streamId || url}
                ref={playerRef}
                src={url}
                controls={canControl}
                playsInline
                preload="metadata"
                muted={playerMuted}
                className="absolute inset-0 h-full w-full bg-black object-contain"
                onLoadedMetadata={(event) => {
                  if (time > 0) event.currentTarget.currentTime = time;
                  onReady?.({ autoplay: false });
                  syncPlayback();
                  syncTime();
                }}
                onPlay={(event) => {
                  playingRef.current = true;
                  if (activated) {
                    event.currentTarget.muted = false;
                    setPlayerMuted(false);
                  }
                  if (consumeProgrammaticEvent('play')) return;
                  if (playing) return;
                  if (!canControl) {
                    markProgrammaticPause();
                    event.currentTarget.pause();
                    return;
                  }
                  setAutoplayBlocked(false);
                  setLocalError('');
                  onPlayPause?.(true);
                }}
                onPause={() => {
                  playingRef.current = false;
                  if (!playing) return;
                  if (!canControl) {
                    reassertRoomState();
                    return;
                  }
                  onPlayPause?.(false);
                }}
                onEnded={() => (onEnded ? onEnded() : onPlayPause?.(false))}
                onTimeUpdate={(event) => onProgress?.(event.currentTarget.currentTime)}
                onDurationChange={(event) => onDuration?.(event.currentTarget.duration)}
                onSeeked={(event) => {
                  if (!canControl) {
                    reassertRoomState();
                    return;
                  }
                  reportSeek(event.currentTarget.currentTime);
                }}
                onError={(event) => {
                  const message = event.currentTarget.error?.code
                    ? `This video failed to load (media error ${event.currentTarget.error.code}).`
                    : 'This video failed to load.';
                  setLocalError(message);
                  onVideoError?.(message);
                }}
              />
            </>
          ) : (
            <ReactPlayer
              key={url}
              ref={playerRef}
              url={url}
              playing={playing}
              controls={canControl}
              playsinline
              muted={playerMuted}
              width="100%"
              height="100%"
              className="absolute inset-0"
              onReady={() => { onReady?.(); syncPlayback(); syncTime(); }}
              onPlay={() => {
                playingRef.current = true;
                if (activated) setPlayerMuted(false);
                if (playing) return;
                if (consumeProgrammaticEvent('play')) return;
                if (!canControl) {
                  markProgrammaticPause();
                  const player = getPlayer();
                  if (player && typeof player.pauseVideo === 'function') player.pauseVideo();
                  else if (player && typeof player.pause === 'function') player.pause();
                  return;
                }
                setAutoplayBlocked(false);
                onPlayPause?.(true);
              }}
              onPause={() => {
                playingRef.current = false;
                if (!playing) return;
                if (!canControl) {
                  reassertRoomState();
                  return;
                }
                onPlayPause?.(false);
              }}
              onEnded={() => (onEnded ? onEnded() : onPlayPause?.(false))}
              onProgress={(state) => onProgress?.(Number(state.playedSeconds || 0))}
              onDuration={(seconds) => onDuration?.(Number(seconds || 0))}
              onSeek={(seconds) => {
                if (!canControl) {
                  reassertRoomState();
                  return;
                }
                reportSeek(Number(seconds || 0));
              }}
              onError={(playerError) => {
                const message = playerError?.message || 'This video could not be played.';
                setLocalError(message);
                onVideoError?.(message);
              }}
            />
          ))) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
              <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-400">
                <MonitorPlay className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-medium text-zinc-200">No video loaded</p>
                <p className="mx-auto mt-1 max-w-xs text-xs leading-5 text-zinc-500">
                  Pick a video from your Drive, paste a YouTube URL, or convert a video to share it.
                </p>
              </div>
            </div>
          )}
          </div>
          {showAutoplayBlocked ? (
            <button
              type="button"
              className="absolute inset-0 z-10 m-auto flex h-12 w-fit items-center justify-center rounded-md bg-black/75 px-5 text-sm font-medium text-white"
              onClick={() => { setAutoplayBlocked(false); syncPlayback(); }}
            >
              Click to start playback
            </button>
          ) : null}
          {showUnmute ? (
            <button
              type="button"
              className="absolute bottom-3 left-3 z-10 flex h-9 w-fit items-center justify-center gap-1.5 rounded-md bg-black/75 px-3 text-xs font-medium text-white"
              onClick={handleUnmute}
            >
              <VolumeX className="h-3.5 w-3.5" />
              Click to Unmute
            </button>
          ) : null}
          {loading ? <div role="status" aria-label="Loading video" className="absolute inset-0 animate-pulse bg-zinc-950/60" /> : null}
          {isTheaterMode && theaterToast ? (
            <div className="absolute top-6 right-6 bg-black/80 text-white px-4 py-2 rounded-full z-[60] truncate max-w-xs">
              {theaterToast}
            </div>
          ) : null}
          {isTheaterMode ? (
            <button
              type="button"
              onClick={onToggleTheater}
              className={`absolute top-4 right-4 z-[60] rounded-md bg-black/70 px-3 py-1.5 text-sm text-white hover:bg-black/90 transition-opacity ${theaterControlsVisible ? 'opacity-100' : 'opacity-0'}`}
            >
              Exit (Esc)
            </button>
          ) : null}
          {isTheaterMode ? (
            <div
              className={`absolute bottom-6 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-3 rounded-full bg-black/70 px-4 py-2 text-white transition-opacity ${theaterControlsVisible ? 'opacity-100' : 'opacity-0'}`}
            >
              <button type="button" onClick={() => onPlayPause?.(!playing)} className="text-sm">
                {playing ? 'Pause' : 'Play'}
              </button>
              <button type="button" onClick={onToggleTheater} className="text-sm">
                Exit
              </button>
            </div>
          ) : null}

        </div>
        <div className="flex flex-wrap items-center justify-between gap-1.5 border-t border-zinc-200/80 px-2 py-1.5 sm:gap-2 sm:px-3 sm:py-2 dark:border-zinc-800">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={url ? 'accent' : 'neutral'} dot>{isStream ? streamName || 'Drive stream' : url ? (isAudio ? 'Audio' : 'Video link') : 'No source'}</Badge>
            {url ? (
              <Badge className="tabular-nums">
                <Clock className="h-3 w-3" />
                <span className="inline-block w-11 text-right">{positionLabel}</span>
                <span className="text-zinc-400">/</span>
                <span className="inline-block w-11 text-left">{durationLabel || '--:--'}</span>
              </Badge>
            ) : null}

            {url ? <Badge tone={playing ? 'success' : 'warning'} dot>{playing ? 'Playing' : 'Paused'}</Badge> : null}
          </div>
          <div className="hidden items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400 sm:flex">
            <Radio className="h-3.5 w-3.5" />{canControl ? 'You can control playback' : 'Host controls playback'}
          </div>
          {!isAudio ? (
            <Button variant="secondary" size="sm" className="hidden sm:inline-flex" onClick={onToggleTheater}>
              {isTheaterMode ? 'Exit Theater' : 'Theater'}
            </Button>
          ) : null}
        </div>
      </Panel>
      {!isTheaterMode ? (
      <form className="flex flex-row items-center gap-1.5 sm:gap-2" onSubmit={submit}>
        <div className="relative min-w-0 flex-1">
          <Link2 className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input
            className={cn(inputClass, 'pl-9')}
            value={inputValue}
            onChange={(event) => setInputValue(event.target.value)}
            placeholder="YouTube or direct video URL"
            aria-label="Video URL"
            disabled={!canControl}
          />
        </div>
        {normalizeVideoUrl(inputValue.trim()) ? (
          <span className={cn(
            'hidden items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium sm:inline-flex',
            isConversionRequired(inputValue.trim())
              ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300'
              : 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300',
          )}>
            {matchPlatform(inputValue.trim())
              ? `${platformLabel(inputValue.trim())} · ${isEmbeddable(inputValue.trim()) ? 'Plays directly' : 'Needs conversion'}`
              : 'Direct video link'}
          </span>
        ) : null}
        <Button
          type="submit"
          variant="secondary"
          disabled={!canControl || (!inputValue.trim() && !hasQueueItems)}
        >
          {inputValue.trim()
            ? (url || streamId
                ? (playing && !(duration && duration > 0 && (duration - (roomTime || 0)) <= 5) ? 'Add to queue' : 'Play')
                : 'Play')
            : (hasQueueItems ? 'Play next' : 'Play')}
        </Button>
        {canConvert ? (
          <Button
            type="button"
            variant="ghost"
            title="Convert a video in a new tab so the room keeps playing"
            onClick={() => (onConvert ? onConvert() : window.open('/convert', '_blank'))}
          >
            <WandSparkles className="h-4 w-4" /> Convert
          </Button>
        ) : null}
      </form>
      ) : null}
      {localError || error ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
          {localError || error}
        </p>
      ) : null}
    </div>
  );
}
