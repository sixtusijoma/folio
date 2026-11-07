import { alignCuesToSentences } from '@/lib/alignWords';
import type { Cue } from '@/lib/types';
import type { VttCue } from '@/lib/vtt';

export function alignCues(cues: VttCue[], sentences: string[] | number, chapter = 0, audio = 0): Cue[] {
  if (Array.isArray(sentences)) {
    if (!cues.length || !sentences.length) return [];
    return alignCuesToSentences(cues, sentences, chapter, audio);
  }
  const sentenceCount = sentences;
  if (!cues.length || sentenceCount <= 0) return [];
  const ratio = cues.length / sentenceCount;
  const zip = ratio > 0.75 && ratio < 1.35;
  return cues.map((cue, index) => ({
    startMs: cue.startMs,
    endMs: Math.max(cue.endMs, cue.startMs + 1),
    chapter,
    audio,
    sentence: zip
      ? Math.min(sentenceCount - 1, index)
      : Math.min(sentenceCount - 1, Math.floor((index * sentenceCount) / cues.length)),
  }));
}

/**
 * How early the next sentence may begin before its cue start.
 * Zero waits for that start. A tenth of a second is the most this may lead,
 * and a previous cue whose end runs long does not hold the old sentence.
 */
export const SENTENCE_LEAD_MS = 0;

function cueBegin(cue: Cue): number {
  return cue.startMs - SENTENCE_LEAD_MS;
}

function cueFinish(cue: Cue): number {
  return cue.endMs;
}

/** Cue active at this position in one audio chapter. Nothing before the first cue or after the last. */
export function cueAt(cues: Cue[], positionMs: number, audioChapter?: number): Cue | null {
  const pool = (audioChapter == null ? cues : cues.filter((cue) => (cue.audio ?? 0) === audioChapter))
    .slice()
    .sort((a, b) => cueBegin(a) - cueBegin(b) || a.sentence - b.sentence);
  if (!pool.length) return null;
  if (positionMs < cueBegin(pool[0])) return null;
  const last = pool[pool.length - 1];
  if (positionMs >= cueFinish(last)) return null;
  let index = -1;
  for (let cursor = 0; cursor < pool.length; cursor += 1) {
    if (cueBegin(pool[cursor]) <= positionMs) index = cursor;
    else break;
  }
  if (index < 0) return null;
  // A later cue's start wins even when the previous cue's end was padded past it.
  return pool[index];
}

export function sentenceForProgress(sentenceCount: number, positionMs: number, durationMs: number): number {
  if (sentenceCount <= 1) return 0;
  if (durationMs <= 0) return 0;
  const ratio = Math.min(0.999, Math.max(0, positionMs / durationMs));
  return Math.min(sentenceCount - 1, Math.floor(ratio * sentenceCount));
}
