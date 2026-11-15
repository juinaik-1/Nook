export function normalizeVideoUrl(rawValue) {
  if (typeof rawValue !== 'string' || rawValue.trim().length > 2048) return null;
  const value = rawValue.trim();
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (url.hostname === 'drive.google.com' || url.hostname.endsWith('.drive.google.com')) {
      const fileId = url.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]+)/)?.[1] || url.searchParams.get('id');
      if (!fileId || !/^[a-zA-Z0-9_-]+$/.test(fileId)) return null;
      return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
    }
    return value;
  } catch {
    return null;
  }
}

// escapePlainText removed: React already escapes text nodes safely, so
// pre-escaping only double-encoded the characters (e.g. apostrophes became
// "&#039;"). Keep this comment so the history of the change is visible.
