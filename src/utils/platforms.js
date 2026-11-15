// Platform capability registry.
//
// Two capabilities exist for a video source:
//   embed   — the browser talks straight to the platform through ReactPlayer.
//             No backend load, no API key, no account. The server only relays
//             the URL over a Supabase broadcast.
//   convert — the platform has no embeddable player, so the source must be
//             downloaded with yt-dlp and converted to H.264 MP4 on the server.
//             This burns disk, CPU and bandwidth, and the platform may rate
//             limit the server's IP.
//
// The embed list mirrors the ReactPlayer providers installed in
// node_modules/react-player/lib/players. The convert list is only platforms
// with no provider at all, so a URL that matches neither is treated as a
// direct video file and played with the FilePlayer.

const PLATFORMS = [
  { id: 'youtube',      label: 'YouTube',      host: 'youtube.com',      mode: 'embed' },
  { id: 'youtu-be',     label: 'YouTube',      host: 'youtu.be',         mode: 'embed' },
  { id: 'vimeo',        label: 'Vimeo',        host: 'vimeo.com',        mode: 'embed' },
  { id: 'twitch',       label: 'Twitch',       host: 'twitch.tv',        mode: 'embed' },
  { id: 'dailymotion',  label: 'Dailymotion',  host: 'dailymotion.com',  mode: 'embed' },
  { id: 'streamable',   label: 'Streamable',   host: 'streamable.com',   mode: 'embed' },
  { id: 'facebook',     label: 'Facebook',     host: 'facebook.com',     mode: 'embed' },
  { id: 'wistia',       label: 'Wistia',       host: 'wistia.net',       mode: 'embed' },
  { id: 'soundcloud',   label: 'SoundCloud',   host: 'soundcloud.com',   mode: 'embed' },
  { id: 'mixcloud',     label: 'Mixcloud',     host: 'mixcloud.com',      mode: 'embed' },
  { id: 'x',            label: 'X / Twitter', host: 'x.com',            mode: 'convert' },
  { id: 'twitter',      label: 'X / Twitter', host: 'twitter.com',      mode: 'convert' },
  { id: 'tiktok',       label: 'TikTok',       host: 'tiktok.com',       mode: 'convert' },
  { id: 'instagram',    label: 'Instagram',    host: 'instagram.com',    mode: 'convert' },
  { id: 'reddit',       label: 'Reddit',       host: 'reddit.com',       mode: 'convert' },
];

export function matchPlatform(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  let hostname;
  try {
    hostname = new URL(url.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
  // Match the most specific host first (e.g. youtu.be before youtube.com).
  const candidates = PLATFORMS.filter((platform) =>
    hostname === platform.host || hostname.endsWith(`.${platform.host}`),
  );
  if (!candidates.length) return null;
  return candidates.sort((a, b) => b.host.length - a.host.length)[0];
}

export function isEmbeddable(url) {
  const platform = matchPlatform(url);
  return platform ? platform.mode === 'embed' : true;
}

export function isConversionRequired(url) {
  const platform = matchPlatform(url);
  return platform ? platform.mode === 'convert' : false;
}

export function platformLabel(url) {
  const platform = matchPlatform(url);
  return platform ? platform.label : 'Video link';
}

export { PLATFORMS };

// Fetch title/author/thumbnail for a video URL from the platform's oEmbed
// endpoint. Always resolves; returns nulls on any failure so queueing never
// blocks or fails because of metadata.
export async function fetchVideoMetadata(url) {
  const empty = { title: null, author: null, thumbnailUrl: null };
  if (typeof url !== 'string' || !url.trim()) return empty;
  let parsed;
  try { parsed = new URL(url.trim()); } catch { return empty; }
  const host = parsed.hostname.toLowerCase();
  let endpoint = null;
  if (host === 'youtube.com' || host === 'www.youtube.com' || host === 'youtu.be' || host === 'm.youtube.com') {
    endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(url.trim())}&format=json`;
  } else if (host === 'vimeo.com' || host === 'www.vimeo.com' || host.endsWith('.vimeo.com')) {
    endpoint = `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url.trim())}`;
  } else if (host === 'tiktok.com' || host === 'www.tiktok.com' || host.endsWith('.tiktok.com')) {
    endpoint = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url.trim())}`;
  }
  if (!endpoint) return empty;
  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return empty;
    const data = await response.json();
    return {
      title: (typeof data?.title === 'string' && data.title.trim()) ? data.title.trim() : null,
      author: (typeof data?.author_name === 'string' && data.author_name.trim()) ? data.author_name.trim() : null,
      thumbnailUrl: (typeof data?.thumbnail_url === 'string' && data.thumbnail_url.trim()) ? data.thumbnail_url.trim() : null,
    };
  } catch {
    return empty;
  }
}
