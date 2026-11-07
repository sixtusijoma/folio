import { hashText } from '@/lib/sentences';

/** Speech at rate 1 runs about 15 characters a second. */
export const CHARS_PER_SECOND = 15;

/** Start the idle clip this far from the end of the live one. */
export const HANDOFF_MS = 120;

/** Kokoro sentences to generate ahead of the one that is playing. */
export const KOKORO_PREFETCH = 4;

export const PLAY_FAILED = 'Audio did not start. Tap to try again.';

/** First Play must start, fall back, or error within this window — never hang. */
export const FIRST_SOUND_MS = 8000;

export type ClipStatus = {
  isLoaded: boolean;
  playing?: boolean;
  didJustFinish?: boolean;
  currentTime: number;
  duration: number;
  error?: string | null;
};

/** replace() has landed on a new source, not the clip that was already loaded. */
export function sourceHasReplaced(
  status: ClipStatus,
  previous: { duration: number; time: number },
  seenUnloaded: boolean,
): boolean {
  if (!status.isLoaded || status.error) {
    return false;
  }
  if (seenUnloaded) {
    return true;
  }
  const durationChanged = Math.abs(status.duration - previous.duration) > 0.05;
  const clockReset = previous.time > 0.35 && status.currentTime <= 0.35;
  return durationChanged || clockReset;
}

/** play() actually began. A paused clock sitting past 0:00 is not a start. */
export function playbackHasStarted(status: ClipStatus, startedAt: number): boolean {
  if (!status.isLoaded || status.error) {
    return false;
  }
  if (status.playing || status.didJustFinish) {
    return true;
  }
  return status.currentTime >= startedAt + 0.05;
}

/** Bound the first clip so a hung engine cannot leave Play waiting. The job keeps running. */
export function raceFirstSound<T>(job: Promise<T>, alreadyPlaying: boolean, timeoutMs = FIRST_SOUND_MS): Promise<T> {
  if (alreadyPlaying) {
    return job;
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error('Kokoro did not finish that sentence.'));
    }, timeoutMs);
    job.then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function estimateSpeechMs(text: string, rate = 1): number {
  const speed = CHARS_PER_SECOND * Math.max(0.25, rate);
  return Math.round((Math.max(1, text.length) / speed) * 1000);
}

export function sentenceSpanMs(
  sentences: string[],
  from: number,
  to: number,
  rate: number,
  actuals?: Array<number | undefined | null>,
): number {
  const start = Math.max(0, Math.min(from, to));
  const end = Math.min(sentences.length, Math.max(from, to));
  let total = 0;
  for (let index = start; index < end; index += 1) {
    const actual = actuals?.[index];
    if (typeof actual === 'number' && actual > 0) {
      total += actual;
    } else {
      total += estimateSpeechMs(sentences[index] ?? '', rate);
    }
  }
  return total;
}

/** Whole-item (or whole-chapter) clock from completed clips plus the one that is playing. */
export function narrationClock(input: {
  elapsedBeforeMs: number;
  clipPositionMs: number;
  clipDurationMs: number;
  remainingAfterMs: number;
}): { positionMs: number; durationMs: number } {
  const clipDuration = Math.max(0, input.clipDurationMs);
  const clipPosition = Math.max(0, input.clipPositionMs);
  const positionMs = Math.max(0, input.elapsedBeforeMs) + clipPosition;
  const currentLength = clipDuration > 0 ? clipDuration : clipPosition;
  const durationMs = Math.max(0, input.elapsedBeforeMs) + currentLength + Math.max(0, input.remainingAfterMs);
  return { positionMs, durationMs };
}

export function shouldHandoff(positionMs: number, durationMs: number, leadMs = HANDOFF_MS): boolean {
  if (durationMs <= 0) {
    return false;
  }
  return positionMs >= Math.max(0, durationMs - leadMs);
}

export function nextClipSlot(live: 0 | 1): 0 | 1 {
  return live === 0 ? 1 : 0;
}

export function prefetchSentences(sentences: string[], from: number, count = KOKORO_PREFETCH): string[] {
  return sentences.slice(from + 1, from + 1 + count).filter((text) => Boolean(text));
}

export function clipPath(itemId: string, engine: string, voice: string, text: string): string {
  return `items/${itemId}/tts/${engine}/${voice}/${hashText(text)}.wav`;
}

export function preparingLine(engine: string, kokoro?: { state: string; progress: number; message: string }): string {
  if (engine === 'kokoro' && kokoro?.state === 'loading') {
    return kokoro.progress > 0 ? `Downloading Kokoro… ${Math.round(kokoro.progress * 100)}%` : 'Preparing voice…';
  }
  if (kokoro?.message && engine === 'kokoro' && kokoro.state === 'loading') {
    return kokoro.message;
  }
  return 'Preparing voice…';
}

export function noticeIsRetryable(message: string): boolean {
  return message === PLAY_FAILED || /could not be downloaded|did not start/i.test(message);
}
