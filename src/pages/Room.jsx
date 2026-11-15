import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  AlertCircle,
  Check,
  Copy,
  Film,
  LogOut,
  Play,
  RefreshCw,
  Users,
} from 'lucide-react';
import Chat from '../components/Chat';
import DriveSource from '../components/DriveSource';
import QueuePanel from '../components/QueuePanel';
import RecentConversions from '../components/RecentConversions';
import UserList from '../components/UserList';
import VideoPlayer from '../components/VideoPlayer';
import VoicePanel from '../components/VoicePanel';
import { Badge, Button, Switch, ThemeToggle } from '../components/ui';
import { useChat } from '../hooks/useChat';
import { useAuth } from '../context/AuthContext';
import { useRoomChannel } from '../hooks/useRoomChannel';
import { useTheme } from '../hooks/useTheme';
import { useQueue } from '../hooks/useQueue';
import { isConversionRequired } from '../utils/platforms';
import { useVideoSync } from '../hooks/useVideoSync';
import { useVoice } from '../hooks/useVoice';
import { cn } from '../utils/cn';
import { resolveDisplayNames } from '../utils/displayNames';
import { acknowledgeConvertedVideo, getConvertRequestId, openConvertTab, subscribeConvertedVideo } from '../utils/roomBridge';

const DISPLAY_NAME_KEY = 'Nook-display-name';
// A handoff that was published long ago belongs to a conversion the room has
// already moved on from. A tab that was suspended in the background can still
// receive it, so an old handoff is ignored.
const MAX_HANDOFF_AGE_MS = 15 * 60_000;

export default function Room() {
  const navigate = useNavigate();
  const location = useLocation();
  const { roomId } = useParams();
  const { theme, toggleTheme } = useTheme();
  const { signOut, user } = useAuth();
  const roomKey = (roomId || '').trim().toUpperCase();
  const isRoomOwner = typeof window !== 'undefined'
    && localStorage.getItem(`Nook-room-owner:${roomKey}`) === '1';
  const storedName =
    typeof window !== 'undefined' ? localStorage.getItem(DISPLAY_NAME_KEY) || 'Guest' : 'Guest';
  const [displayName, setDisplayName] = useState(storedName);
  const [hostOnlyControls, setHostOnlyControls] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const [readyVideo, setReadyVideo] = useState('');

  // A finished conversion is announced with a short toast. It clears itself so
  // a stale message never lingers in the room.
  useEffect(() => {
    if (!readyVideo) return undefined;
    const timer = window.setTimeout(() => setReadyVideo(''), 6000);
    return () => window.clearTimeout(timer);
  }, [readyVideo]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(DISPLAY_NAME_KEY, displayName || 'Guest');
    }
  }, [displayName]);

  // Use the signed-in account's name until the person chooses their own display name.
  useEffect(() => {
    if (!user?.name) return;
    const stored = typeof window !== 'undefined' ? localStorage.getItem(DISPLAY_NAME_KEY) : '';
    if (!stored || stored === 'Guest') setDisplayName(user.name);
  }, [user]);

  useEffect(() => {
    if (!/^[A-Z0-9]{4,6}$/.test(roomKey)) {
      navigate('/');
    }
  }, [roomKey, navigate]);

  const { channel, presenceUsers, hostId, isConnected, connectionStatus, send, updatePresence, transferHost, userId } = useRoomChannel(
    roomKey,
    displayName,
    isRoomOwner,
  );

  const isHost = hostId === userId;
  const canControl = !hostOnlyControls || isHost;

  // Two guests both get the default name, and two people can share a name.
  // Every client resolves the same list the same way, so the room shows
  // "Guest" and "Guest 2", or "Alex" and "Alex 2".
  const displayNames = useMemo(() => resolveDisplayNames(presenceUsers), [presenceUsers]);
  const myDisplayName = displayNames.get(userId) || displayName || 'Guest';
  const peopleWithNames = useMemo(
    () => presenceUsers.map((participant) => ({
      ...participant,
      name: displayNames.get(participant.userId) || participant.name || 'Guest',
    })),
    [presenceUsers, displayNames],
  );

  useEffect(() => {
    // The host owns the toggle and updates presence itself. Letting presence
    // sync write back would clobber an optimistic toggle with a stale value,
    // so only non-host viewers follow the host's presence payload.
    if (isHost) return;
    const hostPresence = presenceUsers.find((participant) => participant.userId === hostId);
    if (hostPresence) setHostOnlyControls(Boolean(hostPresence.hostOnlyControls));
  }, [hostId, presenceUsers, isHost]);

  const changeHostOnlyControls = (value) => {
    setHostOnlyControls(value);
    if (isHost) updatePresence({ hostOnlyControls: value });
  };

  // Identifies the conversion this tab asked for. The room id is what scopes
  // the handoff, so the request id only has to be consistent between the two
  // tabs, not exclusive to this one.
  const convertRequestId = useRef('');
  if (!convertRequestId.current) convertRequestId.current = getConvertRequestId(roomKey);
  // Tracks when the current video actually started playing, so a spurious
  // onEnded (e.g. a load hiccup) does not wipe the queue.
  const playStartedAtRef = useRef(0);
  // The conversion tab, so the room can confirm it picked up the video.
  const convertWindowRef = useRef(null);
  // The stream handed over by the conversion tab. Every load mints a new
  // signed URL and restarts the playback, so the same stream is only applied
  // once.
  const appliedConvertRef = useRef('');

  const queue = useQueue({
    roomId: roomKey,
    channel,
    isConnected,
    send,
    canControl,
    userId,
  });
  const queueRef = useRef(queue);
  queueRef.current = queue;

  // Host-dependent auto-advance fallback. When a non-host controller's video
  // ends, wait 5s for the host to advance; otherwise advance locally.
  const advanceFallbackTimer = useRef(null);
  const clearAdvanceFallback = useCallback(() => {
    if (advanceFallbackTimer.current) {
      window.clearTimeout(advanceFallbackTimer.current);
      advanceFallbackTimer.current = null;
    }
  }, []);
  useEffect(() => {
    clearAdvanceFallback();
  }, [queue.version, clearAdvanceFallback]);

  const video = useVideoSync({
    roomId: roomKey,
    channel,
    isHost,
    canControl,
    send,
    hostOnlyControls,
    hostId,
    userId,
  });

  useEffect(() => {
    if (video.playing) playStartedAtRef.current = Date.now();
  }, [video.playing]);

  // Move the room to the next queued item. The backend advance is idempotent
  // (it only removes the item if it is still the head), so a host and a
  // fallback guest cannot double-skip.
  const playNextQueued = useCallback(async () => {
    if (!canControl) return;
    const items = queueRef.current?.items || [];
    if (!items.length) return;
    // The item that just finished is the one the room was playing. When the
    // playing video is not in the queue, nothing is removed and the head
    // simply starts playing.
    const finished = items.find((item) =>
      (item.streamId && item.streamId === video.streamId)
      || (item.url && item.url === video.url),
    );
    const result = await queueRef.current.advance(finished?.id);
    if (!result?.head) return;
    video.playQueueItem?.(result.head);
  }, [canControl, video.playQueueItem, video.streamId, video.url]);

  useEffect(() => {
    if (isConnected) video.requestState();
  }, [isConnected, video.requestState]);

  // A conversion runs in its own tab and sends the finished video back here.
  //
  // The room id decides which room the video belongs to. The request id is
  // deliberately not used as a filter: a room tab that was refreshed, or that
  // was opened in a browser which did not keep its sessionStorage, no longer
  // knows the id it issued, and dropping the video there would leave the room
  // playing the old one. Any tab of the room applies the handoff and announces
  // it, so the room still converges on the new video when the tab that started
  // the conversion is gone.
  useEffect(() => {
    const unsubscribe = subscribeConvertedVideo((message) => {
      if (!message || message.roomId !== roomKey) return;
      if (!message.streamId) return;
      if (message.at && Date.now() - Number(message.at) > MAX_HANDOFF_AGE_MS) return;
      const confirm = () => {
        acknowledgeConvertedVideo(
          message.id,
          { roomId: roomKey, streamId: message.streamId },
          convertWindowRef.current,
        );
      };
      if (appliedConvertRef.current === message.streamId) {
        // Already playing here. Still confirm, so the conversion tab stops
        // repeating the handoff.
        confirm();
        return;
      }
      // Upgrade any pending queue item that this conversion fulfils.
      const q = queueRef.current;
      const pendingItem = (q?.items || []).find((item) =>
        item.status === 'pending'
        && (item.jobId === message.jobId || (message.url && item.url === message.url)),
      );
      if (pendingItem) {
        const upgradedTitle = (message.name && message.name.trim() && message.name !== 'Converted video' && !/\\.(com|net|org)$/i.test(message.name.trim()))
          ? message.name.trim()
          : pendingItem.title;
        void q.patch(pendingItem.id, { kind: 'stream', streamId: message.streamId, jobId: message.jobId, status: 'ready', title: upgradedTitle }).catch(() => {});
      }
      const applyVideo = async () => {
        // Claim it before the request goes out, so a repeated message cannot
        // start a second load of the same stream.
        appliedConvertRef.current = message.streamId;
        try {
          const applied = await video.shareConvertedVideo(
            { streamId: message.streamId, name: message.name },
            { autoplay: canControl },
          );
          if (!applied) {
            appliedConvertRef.current = '';
            return;
          }
          // Confirm the video is ready so the room knows it is playing.
          setReadyVideo(message.name || 'Converted video');
          confirm();
        } catch {
          // Let a later handoff try again.
          appliedConvertRef.current = '';
        }
      };
      void applyVideo();
    });
    return unsubscribe;
  }, [roomKey, canControl, video.shareConvertedVideo]);

  // Open the conversion page in a separate tab so the room keeps playing.
  const openConverter = (streamOrPayload) => {
    const payload = streamOrPayload || {};
    convertWindowRef.current = openConvertTab({
      roomId: roomKey,
      requestId: convertRequestId.current,
      streamId: payload.streamId,
      name: payload.name,
      url: payload.url,
      auto: payload.auto,
    });
  };

  // Play one of the account's recent conversions in the room. It uses the
  // same handoff as a finished conversion, so every participant switches to
  // it and the host decides when it starts.
  const playRecentConversion = (stream) => {
    if (!stream?.streamId) return;
    void video.shareConvertedVideo(
      { streamId: stream.streamId, name: stream.name },
      { autoplay: canControl },
    );
    setReadyVideo(stream.name || 'Converted video');
  };

  useEffect(() => {
    const sharedStream = location.state?.streamId;
    if (sharedStream) {
      void video.loadStream({ streamId: sharedStream, name: location.state.name });
      navigate(`/room/${roomKey}`, { replace: true, state: null });
    }
  }, [location.key, location.state, navigate, roomKey, video.loadStream]);

  const chat = useChat({ roomId: roomKey, channel, displayName: myDisplayName, userId });
  const voice = useVoice({
    roomId: roomKey,
    channel,
    userId,
    displayName,
    presenceUsers,
    isConnected,
    updatePresence,
  });

  const previousPresenceRef = useRef([]);
  const previousPresenceRoomRef = useRef(roomKey);

  useEffect(() => {
    if (previousPresenceRoomRef.current !== roomKey) {
      previousPresenceRoomRef.current = roomKey;
      previousPresenceRef.current = [];
      return;
    }
    const previousMap = new Map(previousPresenceRef.current.map((item) => [item.userId, item]));
    const nextMap = new Map(presenceUsers.map((item) => [item.userId, item]));

    const joinedUsers = presenceUsers.filter((item) => !previousMap.has(item.userId));
    const leftUsers = previousPresenceRef.current.filter((item) => !nextMap.has(item.userId));

    joinedUsers.forEach((user) => {
      chat.addSystemMessage(`${user.name || 'Guest'} joined the room`);
    });

    leftUsers.forEach((user) => {
      chat.addSystemMessage(`${user.name || 'Guest'} left the room`);
    });

    previousPresenceRef.current = presenceUsers;
  }, [presenceUsers, chat.addSystemMessage, roomKey]);

  const copyInviteLink = async () => {
    const inviteUrl = `${window.location.origin}/room/${roomKey}`;

    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopyStatus('Invite link copied');
    } catch (error) {
      setCopyStatus(`Copy failed. Share this manually: ${inviteUrl}`);
    }

    window.setTimeout(() => setCopyStatus(''), 2000);
  };

  const leaveRoom = () => {
    voice.leaveVoice();
    navigate('/');
  };

  const copySucceeded = copyStatus.startsWith('Invite link copied');
  const peopleLabel = presenceUsers.length === 1 ? 'person' : 'people';

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <header className="sticky top-0 z-20 border-b border-zinc-200/80 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mx-auto flex h-14 max-w-[1440px] items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-zinc-900 text-white shadow-sm dark:bg-zinc-100 dark:text-zinc-900">
              <Play className="h-3.5 w-3.5 fill-current" strokeWidth={2} />
            </span>

            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <h1 className="shrink-0 text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
                  Room
                </h1>
                <Badge className="font-mono tracking-[0.14em]">{roomKey}</Badge>
                <span
                  className={cn(
                    'h-1.5 w-1.5 shrink-0 rounded-full sm:hidden',
                    isConnected ? 'bg-emerald-500' : 'bg-amber-500',
                  )}
                  title={isConnected ? 'Connected to the room' : 'Connecting to the room'}
                />
              </div>
              <p className="hidden items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400 sm:flex">
                <Users className="h-3 w-3" strokeWidth={1.75} />
                {presenceUsers.length} {peopleLabel}
                <span className="text-zinc-300 dark:text-zinc-700">·</span>
                {isHost ? 'You are the host' : 'Host controls playback'}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            <span
              className="hidden sm:inline-flex"
              title={isConnected ? 'Connected to the room' : 'Connecting to the room'}
            >
              <Badge tone={connectionStatus === 'connected' ? 'success' : connectionStatus === 'error' ? 'danger' : 'warning'} dot>
                {connectionStatus === 'connected' ? 'Connected' : connectionStatus === 'error' ? 'Connection issue' : 'Connecting'}
              </Badge>
            </span>

            <Button
              variant="secondary"
              size="sm"
              onClick={copyInviteLink}
              aria-label="Copy invite link"
            >
              {copySucceeded ? (
                <Check className="h-3.5 w-3.5" strokeWidth={2} />
              ) : (
                <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />
              )}
              <span className="hidden sm:inline">{copySucceeded ? 'Copied' : 'Copy invite'}</span>
            </Button>

            <ThemeToggle theme={theme} onToggle={toggleTheme} />

            <Button variant="ghost" size="sm" onClick={leaveRoom} aria-label="Leave room">
              <LogOut className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span className="hidden sm:inline">Leave</span>
            </Button>

            {user ? (
              <Button variant="ghost" size="sm" onClick={() => { signOut(); navigate('/'); }} aria-label="Sign out">
                Sign out
              </Button>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => navigate('/signin', { state: { from: `/room/${roomKey}` } })} aria-label="Sign in">
                Sign in
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1440px] px-4 py-4 sm:px-6 sm:py-6">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start lg:gap-6">
          <div className="flex min-w-0 flex-col gap-4">
            <VideoPlayer
              url={video.url}
              streamId={video.streamId}
              streamName={video.streamName}
              playing={video.playing}
              time={video.time}
              roomTime={video.roomTime}
              duration={video.duration}
              canControl={canControl}
              canConvert={Boolean(user)}
              isHost={isHost}
              loading={video.loading}
              error={video.error}
              syncNonce={video.syncNonce}
              onPlayPause={video.handlePlayPause}
              onSeek={video.handleSeek}
              onProgress={video.handleProgress}
              onDuration={video.handleDuration}
              onLoadVideo={video.loadVideo}
              onReady={video.handleReady}
              onVideoError={(message) => {
                video.handleVideoError?.(message);
                if (!canControl || !queue.items.length) return;
                const head = queue.items[0];
                // Only treat it as a queue failure if the errored video is the
                // queued head, so a transient error on an unrelated video does
                // not wipe the queue.
                const matchesHead = (head.streamId && head.streamId === video.streamId)
                  || (head.url && head.url === video.url);
                if (!matchesHead) return;
                (async () => {
                  try { await queue.patch(head.id, { status: 'failed' }); } catch { /* ignore */ }
                  // The advance removes the failed head and hands back the
                  // next one, so the failed item is not played.
                  try {
                    const result = await queue.advance(head.id);
                    if (result?.advanced && result.head) video.playQueueItem?.(result.head);
                  } catch { /* ignore */ }
                })();
              }}
              onConvert={openConverter}
              onPlayNext={() => { void playNextQueued(); }}
              hasQueueItems={queue.items.length > 0}
              onQueueAdd={async (normalized) => {
                try {
                  if (isConversionRequired(normalized)) {
                    await queue.add({ kind: 'job', url: normalized, title: null, status: 'pending', addedBy: userId });
                    openConverter({ url: normalized, auto: true });
                  } else {
                    await queue.add({ kind: 'url', url: normalized, title: null, status: 'ready', addedBy: userId });
                  }
                } catch (error) {
                  // Surface via the player's local error is not available here;
                  // the queue panel will show it on next interaction.
                  console.error('Unable to queue video:', error?.message || error);
                }
              }}
              onEnded={() => {
                if (!canControl || !queue.items.length) return;
                // Ignore spurious ended events fired right after a load.
                if (Date.now() - playStartedAtRef.current < 3000) return;
                if (isHost) {
                  void playNextQueued();
                } else {
                  // The host normally advances. Give it a few seconds, then
                  // do it ourselves. The backend advance is idempotent.
                  clearAdvanceFallback();
                  advanceFallbackTimer.current = window.setTimeout(() => {
                    void playNextQueued();
                  }, 5000);
                }
              }}
            />

            {user ? (
              <>
                <DriveSource
                  onLoadStream={(stream) => {
                    const nearEnd = Boolean(video.duration && video.duration > 0 && (video.duration - (video.roomTime || 0)) <= 5);
                    const shouldQueue = Boolean(video.url || video.streamId) && video.playing && !nearEnd;
                    if (shouldQueue && stream?.streamId) {
                      void queue.add({ kind: 'stream', streamId: stream.streamId, title: stream.name || 'Drive video', status: 'ready', addedBy: userId });
                      return;
                    }
                    video.loadStream?.(stream);
                  }}
                  onConvert={openConverter}
                />
                <RecentConversions onPlay={playRecentConversion} />
              </>
            ) : (
              <p className="rounded-md border border-zinc-200/80 bg-white px-3 py-2 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                Guest mode: you can watch, chat, and join voice. Sign in to use Drive or convert videos.
              </p>
            )}
            <QueuePanel
              queue={queue}
              canControl={canControl}
              participantId={userId}
              people={peopleWithNames}
              roomId={roomKey}
              requestId={convertRequestId.current}
              currentUrl={video.url}
              currentStreamId={video.streamId}
              currentStreamName={video.streamName}
              onPlayCurrent={async (item) => {
                if (item?.streamId) {
                  await video.loadStream?.({ streamId: item.streamId, name: item.title || 'Queued video' });
                } else if (item?.url) {
                  video.loadVideo?.(item.url);
                }
                if (canControl) {
                  window.setTimeout(() => video.playNow?.(), 150);
                }
              }}
            />

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-200/80 bg-white px-3 py-2.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              {isHost ? (
                <Switch
                  id="host-only-controls"
                  checked={hostOnlyControls}
                  onChange={(event) => changeHostOnlyControls(event.target.checked)}
                  label="Host-only controls"
                />
              ) : <span className="text-xs text-zinc-500">{hostOnlyControls ? 'Host-only playback controls' : 'Everyone can control playback'}</span>}
              <Button variant="secondary" size="sm" onClick={video.requestState}>
                <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
                Request sync
              </Button>
            </div>

            <VoicePanel
              isJoined={voice.isJoined}
              isMuted={voice.isMuted}
              error={voice.error}
              remoteUsers={voice.remoteUsers}
              joinVoice={voice.joinVoice}
              leaveVoice={voice.leaveVoice}
              toggleMute={voice.toggleMute}
              setRemoteVolume={voice.setRemoteVolume}
            />

            <UserList
              users={peopleWithNames}
              hostId={hostId}
              currentUserId={userId}
              onTransferHost={(targetUserId) => transferHost(targetUserId, hostOnlyControls)}
              speakingUsers={voice.remoteUsers.map((user) => user.userId).filter(Boolean)}
              isConnected={isConnected}
              connectionStatus={connectionStatus}
            />
          </div>

          <Chat
            messages={chat.messages}
            onSendMessage={chat.sendMessage}
            currentUserId={userId}
            displayName={myDisplayName}
            className="h-[560px] min-h-[420px] lg:sticky lg:top-[72px] lg:h-[calc(100vh-88px)]"
          />
        </div>
      </main>

      {copyStatus ? (
        <div
          role="status"
          className={cn(
            'fixed left-4 right-4 z-50 mx-auto flex max-w-sm items-start gap-2 rounded-md border border-zinc-200/80 bg-white px-3 py-2.5 text-xs leading-5 text-zinc-600 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 sm:left-auto sm:right-6 sm:mx-0',
            readyVideo ? 'bottom-28' : 'bottom-4',
          )}
        >
          {copySucceeded ? (
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" strokeWidth={2} />
          ) : (
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" strokeWidth={1.75} />
          )}
          <span className="min-w-0 break-words">{copyStatus}</span>
        </div>
      ) : null}

      {readyVideo ? (
        <div
          role="status"
          className="fixed bottom-4 left-4 right-4 z-50 mx-auto flex max-w-sm items-start gap-2 rounded-md border border-emerald-200/80 bg-emerald-50 px-3 py-2.5 text-xs leading-5 text-emerald-800 shadow-sm dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300 sm:left-auto sm:right-6 sm:mx-0"
        >
          <Film className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" strokeWidth={2} />
          <span className="min-w-0 break-words">
            New video ready: <span className="font-medium">{readyVideo}</span>
          </span>
        </div>
      ) : null}
    </div>
  );
}
