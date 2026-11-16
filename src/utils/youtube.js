export async function searchYouTube(query) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return [];

  const key = import.meta.env.VITE_YOUTUBE_API_KEY;
  if (!key) throw new Error('Missing VITE_YOUTUBE_API_KEY.');

  const response = await fetch(
    `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=8&q=${encodeURIComponent(trimmed)}&key=${encodeURIComponent(key)}`,
  );
  if (!response.ok) throw new Error(`YouTube search failed (${response.status}).`);

  const json = await response.json();
  const items = Array.isArray(json.items) ? json.items : [];

  return items.map((item) => {
    const id = item?.id?.videoId || '';
    return {
      id,
      title: item?.snippet?.title || '',
      artist: item?.snippet?.channelTitle || '',
      image: item?.snippet?.thumbnails?.high?.url || item?.snippet?.thumbnails?.medium?.url || item?.snippet?.thumbnails?.default?.url || '',
      videoUrl: `https://www.youtube.com/watch?v=${id}`,
    };
  }).filter((item) => item.id);
}
