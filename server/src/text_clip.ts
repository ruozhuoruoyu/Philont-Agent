/**
 * Clip text for a channel with a hard length cap WITHOUT cutting a sentence in half.
 *
 * 2026-10-09: three places clipped owner-facing text with a bare `.slice(0, N)`: the WeChat progress relay
 * (900 chars — four deliberation reports in one day stopped mid-sentence with nothing marking the cut),
 * the auto-advance milestone template (claims at 120 chars, next step at 160) and the end-of-session
 * summary (600). The owner read all of them as "the summary is truncated". A cap is fine; a cut that
 * looks like the end of the text is not.
 */

const SENTENCE_BOUNDARY = /[。！？；\n]|[.!?;]\s/g;

/**
 * Return `text` unchanged when it fits in `max`; otherwise the longest prefix that ends at a sentence or
 * line boundary (never shorter than 60% of the room) followed by `marker`. Falls back to a whitespace
 * boundary, then to a plain cut. `marker` counts against `max`.
 */
export function clipAtBoundary(text: string, max: number, marker = '…'): string {
  if (!text || text.length <= max) return text;
  const room = Math.max(1, max - marker.length);
  const head = text.slice(0, room);
  const floor = Math.floor(room * 0.6);
  let cut = -1;
  for (const m of head.matchAll(SENTENCE_BOUNDARY)) {
    const end = m.index + m[0].length;
    if (end >= floor) cut = end;
  }
  if (cut < 0) {
    const ws = head.lastIndexOf(' ');
    if (ws >= floor) cut = ws;
  }
  const kept = (cut > 0 ? head.slice(0, cut) : head).replace(/\s+$/, '');
  return kept + marker;
}
