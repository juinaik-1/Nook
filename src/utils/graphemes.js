// Grapheme-aware text helpers.
//
// JavaScript strings are UTF-16 code units, not characters. A family emoji is
// 11 code units but one visible character, so a 500-character limit can be
// exhausted by 45 emoji, and slicing in the middle of a ZWJ sequence produces
// a broken glyph. Intl.Segmenter counts grapheme clusters, which is what the
// user actually sees. It is built into every modern browser and Node 16+, so
// there is no dependency.
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function countGraphemes(value) {
  return [...segmenter.segment(String(value ?? ''))].length;
}

export function sliceGraphemes(value, limit) {
  const segments = [...segmenter.segment(String(value ?? ''))];
  if (segments.length <= limit) return String(value ?? '');
  return segments.slice(0, limit).map((segment) => segment.segment).join('');
}
