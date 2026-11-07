import type { LibraryItem, ListenMode, Locator } from '@/lib/types';

export function isBundledNarration(item: { bundledAudio?: boolean }): boolean {
  return item.bundledAudio === true;
}

/** A scripted audio item can play its recording or be read in the Settings voice. */
export function offersVoiceChoice(item: Pick<LibraryItem, 'kind' | 'hasText'>): boolean {
  if (item.kind !== 'audio' && item.kind !== 'audiobook') {
    return false;
  }
  return Boolean(item.hasText);
}

export function listenMode(item: Pick<LibraryItem, 'kind' | 'hasText' | 'listen'>): ListenMode {
  if (offersVoiceChoice(item) && item.listen === 'voice') {
    return 'voice';
  }
  return 'recording';
}

export type PlaybackPlan = { action: 'file' } | { action: 'narrate' } | { action: 'error'; message: string };

export function playbackPlan(
  item: Pick<LibraryItem, 'kind' | 'bundledAudio' | 'hasAudio' | 'hasText' | 'listen'>,
  mode: 'audio' | 'narrate',
): PlaybackPlan {
  if (listenMode(item) === 'voice') {
    return { action: 'narrate' };
  }
  if (isBundledNarration(item)) {
    if (!item.hasAudio) {
      return {
        action: 'error',
        message: 'The bundled recording is missing, so Folio will not switch to another voice.',
      };
    }
    return { action: 'file' };
  }
  if (mode === 'narrate' || !item.hasAudio) {
    if (!item.hasText) {
      return { action: 'error', message: 'This item has no text to narrate.' };
    }
    return { action: 'narrate' };
  }
  return { action: 'file' };
}

export type ClipWatch = { sawReset: boolean; sawProgress: boolean };

export function freshClipWatch(): ClipWatch {
  return { sawReset: false, sawProgress: false };
}

/**
 * Ignore a finish event from the clip that was replaced.
 * A new clip counts only after time has fallen near the start, then moved forward, then reached the end.
 */
export function reduceClipStatus(
  state: ClipWatch,
  status: { positionMs: number; durationMs: number; didJustFinish: boolean },
): { state: ClipWatch; finished: boolean } {
  const next: ClipWatch = { sawReset: state.sawReset, sawProgress: state.sawProgress };
  if (!next.sawReset) {
    if (status.positionMs <= 350) next.sawReset = true;
    else return { state: next, finished: false };
  }
  if (status.positionMs > 50) next.sawProgress = true;
  const duration = status.durationMs;
  const nearEnd = duration > 0 && status.positionMs >= Math.max(0, duration - 140);
  const finished = next.sawProgress && nearEnd && (status.didJustFinish || status.positionMs >= duration - 90);
  return { state: next, finished };
}

// Speech at normal rate runs about 15 characters a second, which turns a skip in seconds into sentences.
const CHARS_PER_SECOND = 15;

/**
 * Sentence a skip lands on while narrating. Narration has no clock to seek, so the skip length is spent
 * on the text around the current sentence, and a skip always moves at least one sentence.
 */
export function skipSentence(sentences: string[], from: number, deltaMs: number): number {
  if (!sentences.length) {
    return 0;
  }
  const last = sentences.length - 1;
  let index = Math.min(last, Math.max(0, from));
  let budget = (Math.abs(deltaMs) / 1000) * CHARS_PER_SECOND;
  if (deltaMs < 0) {
    while (index > 0 && budget > 0) {
      index -= 1;
      budget -= sentences[index].length;
    }
    return index;
  }
  while (index < last && budget > 0) {
    budget -= sentences[index].length;
    index += 1;
  }
  return index;
}

export type Transport = { playing: boolean; positionMs: number };

export function reduceTransport(state: Transport, action: 'toggle' | 'play' | 'pause' | 'seek', deltaMs = 0): Transport {
  if (action === 'toggle') return { playing: !state.playing, positionMs: state.positionMs };
  if (action === 'play') return { playing: true, positionMs: state.positionMs };
  if (action === 'pause') return { playing: false, positionMs: state.positionMs };
  return { playing: state.playing, positionMs: Math.max(0, state.positionMs + deltaMs) };
}

export function visibleFollow(
  followPlayback: boolean,
  mark: { chapter: number; sentence: number } | null,
): { chapter: number; sentence: number } | null {
  if (!followPlayback || !mark) return null;
  return { chapter: mark.chapter, sentence: mark.sentence };
}

export const NOW_PLAYING_ROLE = 'button' as const;

export function nowPlayingAccessibilityLabel(title: string): string {
  return `Open ${title}`;
}

export function readerItemId(pathname: string): string | null {
  const path = pathname.split('?')[0].replace(/\/+$/, '') || '/';
  const match = path.match(/\/read\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

/** Stay when that item's reader is already the current screen, so the stack is not duplicated. */
export function nowPlayingReaderAction(pathname: string, itemId: string): 'stay' | 'open' {
  return readerItemId(pathname) === itemId ? 'stay' : 'open';
}

/** Audio chapter that reads this text chapter, or -1 when the text has no recording (front matter, endnotes). */
export function audioIndexForTextChapter(chapters: { textChapter?: number | null }[], textIndex: number): number {
  return chapters.findIndex((chapter) => chapter.textChapter === textIndex);
}

/** A network failure from a streamed chapter should not surface as the browser's "Failed to fetch". */
export function playbackNotice(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : '';
  if (/failed to fetch|network request failed|load failed|networkerror|err_failed/i.test(message)) {
    return 'This chapter could not be downloaded. Check the connection and try again.';
  }
  return message || 'Playback failed.';
}

/** Pause then play continues the file already loaded. Reloading would jump back to the last saved position. */
export function resumeChoice(fileLoaded: boolean): 'continue' | 'reload' {
  return fileLoaded ? 'continue' : 'reload';
}

export function locatorForSpoken(current: Locator | null, spoken: { chapter: number; sentence: number } | null): Locator {
  if (!spoken) return current ?? { chapter: 0, page: 0, sentence: 0 };
  return { chapter: spoken.chapter, page: 0, sentence: spoken.sentence };
}

export type NowPlayingTarget = { id: string; chapter: string; sentence: string; place: 'sentence' };

export function nowPlayingNavigation(pathname: string, itemId: string, locator: Locator): NowPlayingTarget | 'stay' {
  if (nowPlayingReaderAction(pathname, itemId) === 'stay') return 'stay';
  return { id: itemId, chapter: String(locator.chapter), sentence: String(locator.sentence), place: 'sentence' };
}

export function itemDateLabel(item: Pick<LibraryItem, 'dateLabel'>): string | null {
  const label = item.dateLabel?.trim();
  if (!label) {
    return null;
  }
  return label;
}
