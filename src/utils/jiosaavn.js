// Thin client for the unofficial JioSaavn API (see jiosaavn-api.json).
// All calls go straight to the hosted worker; the backend is not involved.
const BASE = 'https://jiosavan.100coldice.workers.dev';

function pickImage(image) {
  const imageArray = Array.isArray(image) ? image : [];
  return imageArray.length > 0 ? imageArray[imageArray.length - 1]?.url || '' : image?.url || '';
}

function mapSong(song) {
  const downloads = Array.isArray(song.downloadUrl) ? song.downloadUrl : [];
  const preferred =
    downloads.find((entry) => entry?.quality === '320kbps') ||
    downloads[downloads.length - 1];
  return {
    id: song.id,
    title: song.name || song.title,
    artist: song.artists?.primary?.[0]?.name || song.primaryArtists || song.singers || '',
    thumbnailUrl: pickImage(song.image),
    audioUrl: preferred?.url || '',
  };
}

function collectArtistNames(song) {
  const primary = (song?.artists?.primary || []).map((a) => a?.name || '');
  const featured = (song?.artists?.featured || []).map((a) => a?.name || '');
  const all = (song?.artists?.all || []).map((a) => a?.name || '');
  const extra = [song?.primaryArtists || '', song?.singers || ''];
  return { primary, allNames: [...primary, ...featured, ...all, ...extra] };
}

function nameMatches(needle, value) {
  const n = String(needle).trim().toLowerCase();
  const v = String(value || '').trim().toLowerCase();
  if (!n || !v) return false;
  return v === n || v.includes(n) || n.includes(v);
}

function filterSongsByArtist(list, name) {
  if (!name || !Array.isArray(list)) return list || [];
  const primary = list.filter((s) => collectArtistNames(s).primary.some((v) => nameMatches(name, v)));
  if (primary.length) return primary;
  const any = list.filter((s) => collectArtistNames(s).allNames.some((v) => nameMatches(name, v)));
  return any.length ? any : [];
}

function getResults(json) {
  return json?.data?.results || json?.data?.data?.results || json?.results || json?.data || [];
}

export async function searchSongs(query) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return [];
  const response = await fetch(`${BASE}/api/search/songs?query=${encodeURIComponent(trimmed)}`);
  if (!response.ok) throw new Error(`JioSaavn search failed (${response.status}).`);
  const json = await response.json();
  return getResults(json).map(mapSong).filter((s) => s.audioUrl);
}

export async function searchArtists(query) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return [];
  const response = await fetch(`${BASE}/api/search/artists?query=${encodeURIComponent(trimmed)}`);
  if (!response.ok) throw new Error(`JioSaavn search failed (${response.status}).`);
  const json = await response.json();
  return getResults(json).map((artist) => ({
    id: artist.id,
    name: artist.name || artist.title,
    image: pickImage(artist.image),
    type: 'artist',
  }));
}

export async function searchAlbums(query) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return [];
  const response = await fetch(`${BASE}/api/search/albums?query=${encodeURIComponent(trimmed)}`);
  if (!response.ok) throw new Error(`JioSaavn search failed (${response.status}).`);
  const json = await response.json();
  return getResults(json).map((album) => ({
    id: album.id,
    name: album.name || album.title,
    artist: album.artists?.primary?.[0]?.name || album.artist || '',
    image: pickImage(album.image),
    type: 'album',
  }));
}

export async function getAlbumSongs(id) {
  if (!id) return [];
  const response = await fetch(`${BASE}/api/albums?id=${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error(`JioSaavn album fetch failed (${response.status}).`);
  const json = await response.json();
  const songs = json?.data?.songs || json?.data?.data?.songs || [];
  return songs.map(mapSong).filter((s) => s.audioUrl);
}

export async function getArtistSongs(id, name = '') {
  if (!id) return [];

  const collected = [];

  const addRaw = (arr) => {
    if (Array.isArray(arr)) collected.push(...arr);
  };

  try {
    const response = await fetch(`${BASE}/api/artists/${encodeURIComponent(id)}/songs?page=0&sortBy=popularity&sortOrder=desc`);
    if (response.ok) {
      const json = await response.json();
      addRaw(json?.data?.songs || json?.data?.results || json?.data?.data?.songs);
    }
  } catch { /* ignore */ }

  try {
    const response = await fetch(`${BASE}/api/artists?id=${encodeURIComponent(id)}`);
    if (response.ok) {
      const json = await response.json();
      const data = json?.data || {};
      addRaw(data.topSongs);
      addRaw(data.singles);
      addRaw(data.songs);
    }
  } catch { /* ignore */ }

  if (name) {
    try {
      const response = await fetch(`${BASE}/api/search/songs?query=${encodeURIComponent(name)}&limit=20`);
      if (response.ok) {
        const json = await response.json();
        addRaw(getResults(json));
      }
    } catch { /* ignore */ }
  }

  let candidates = collected;
  if (name) {
    const strict = candidates.filter((s) => collectArtistNames(s).primary.some((v) => nameMatches(name, v)));
    const loose = candidates.filter((s) => collectArtistNames(s).allNames.some((v) => nameMatches(name, v)));
    candidates = strict.length ? strict : (loose.length ? loose : candidates);
  }

  const seen = new Set();
  const mapped = [];
  for (const song of candidates) {
    const item = mapSong(song);
    if (!item.audioUrl || !item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    mapped.push(item);
  }
  return mapped;
}