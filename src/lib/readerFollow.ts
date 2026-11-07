/** Keep the spoken sentence in this band of the viewport. Outside it, scroll. */
export const FOLLOW_TOP = 0.18;
export const FOLLOW_BOTTOM = 0.72;

export function shouldFollowScroll(rect: { top: number; bottom: number }, viewportHeight: number): boolean {
  if (viewportHeight <= 0) return false;
  return rect.top < viewportHeight * FOLLOW_TOP || rect.bottom > viewportHeight * FOLLOW_BOTTOM;
}

export function scrollRatio(scrollTop: number, scrollHeight: number, clientHeight: number): number {
  const range = scrollHeight - clientHeight;
  if (range <= 0) return 0;
  return Math.min(1, Math.max(0, scrollTop / range));
}

export function readingProgress(chapterCount: number, chapter: number, ratio: number): number {
  if (chapterCount <= 0) return 0;
  const clamped = Math.min(1, Math.max(0, ratio));
  return Math.min(1, (Math.max(0, chapter) + clamped) / chapterCount);
}

export type FollowMode = 'following' | 'suspended';

export function reduceFollow(state: FollowMode, event: 'user-scroll' | 'resume' | 'play'): FollowMode {
  if (event === 'user-scroll') return 'suspended';
  return state === 'suspended' || event === 'resume' || event === 'play' ? 'following' : state;
}

export type LookPosition = { chapter: number; sentence: number; scroll?: number };

export type OpeningPlace = { chapter: number; sentence: number; scroll: number | null };

/**
 * Jump to the spoken sentence only while that item is playing with follow on,
 * or when the now-playing bar opened the reader. A paused or never-played item
 * keeps the saved scroll.
 */
export function openingPlace(input: {
  fromBar: boolean;
  playing: boolean;
  followOn: boolean;
  spoken: { chapter: number; sentence: number } | null;
  saved: LookPosition | null;
}): OpeningPlace {
  const trackSpoken = (input.fromBar || (input.playing && input.followOn)) && input.spoken != null;
  if (trackSpoken && input.spoken) {
    return { chapter: input.spoken.chapter, sentence: input.spoken.sentence, scroll: null };
  }
  if (!input.saved) return { chapter: 0, sentence: 0, scroll: null };
  const scroll = input.saved.scroll != null && Number.isFinite(input.saved.scroll) ? input.saved.scroll : null;
  return { chapter: input.saved.chapter, sentence: input.saved.sentence, scroll };
}

export type ScrollOrigin = 'restore' | 'user' | 'follow';

/** The first programmatic open must not replace the place the reader was already keeping. */
export function shouldPersistScroll(origin: ScrollOrigin): boolean {
  return origin === 'user' || origin === 'follow';
}

export function applyScrollReport(
  saved: LookPosition | null,
  report: { origin: ScrollOrigin; chapter: number; sentence: number; scroll: number },
): LookPosition | null {
  if (!shouldPersistScroll(report.origin)) return saved;
  return { chapter: report.chapter, sentence: report.sentence, scroll: report.scroll };
}
