import { cueAt, sentenceForProgress } from '@/lib/cues';
import type { AudioChapter, Cue, SyncMode } from '@/lib/types';

export type Spoken = { chapter: number; sentence: number } | null;

export type SpokenSource = {
  sync: SyncMode;
  cues: Cue[];
  chapters: { sentences: number }[];
  audioChapters: AudioChapter[];
};

function chapterCues(cues: Cue[], audioChapter: number): Cue[] {
  return cues.filter((cue) => (cue.audio ?? 0) === audioChapter);
}

/** Sentence the recording is in. Nothing is drawn from this. */
export function spokenAt(item: SpokenSource, audioChapter: number, positionMs: number, durationMs: number): Spoken {
  const scoped = chapterCues(item.cues, audioChapter);
  if (item.sync === 'vtt' && scoped.length) {
    const cue = cueAt(item.cues, positionMs, audioChapter);
    if (!cue) return null;
    return { chapter: cue.chapter, sentence: cue.sentence };
  }
  return approximateSpoken(item, audioChapter, positionMs, durationMs);
}

/**
 * Sentence to start narrating from when the recording is left at this position. Unlike spokenAt, a gap
 * between captions keeps the caption before it, so switching mid-pause does not lose the place.
 * Without captions the place is estimated, which needs the file's duration.
 */
export function sentenceAtTime(item: SpokenSource, audioChapter: number, positionMs: number, durationMs: number): Spoken {
  const scoped = chapterCues(item.cues, audioChapter).sort((a, b) => a.startMs - b.startMs || a.sentence - b.sentence);
  if (item.sync === 'vtt' && scoped.length) {
    let found = scoped[0];
    for (const cue of scoped) {
      if (cue.startMs > positionMs) {
        break;
      }
      found = cue;
    }
    return { chapter: found.chapter, sentence: found.sentence };
  }
  if (durationMs <= 0) {
    return null;
  }
  return approximateSpoken(item, audioChapter, positionMs, durationMs);
}

/**
 * Where the recording says this sentence. A sentence with no caption of its own starts at the nearest
 * earlier one. Null when the item has no caption timing to map by.
 */
export function timeForSentence(item: SpokenSource, chapter: number, sentence: number): { audioChapter: number; positionMs: number } | null {
  if (item.sync !== 'vtt') {
    return null;
  }
  let best: Cue | null = null;
  for (const cue of item.cues) {
    if (cue.chapter !== chapter || cue.sentence > sentence) {
      continue;
    }
    if (!best || cue.sentence > best.sentence || (cue.sentence === best.sentence && cue.startMs < best.startMs)) {
      best = cue;
    }
  }
  if (!best) {
    return null;
  }
  return { audioChapter: best.audio ?? 0, positionMs: best.startMs };
}

export function approximateSpoken(item: SpokenSource, audioChapter: number, positionMs: number, durationMs: number): Spoken {
  const audio = item.audioChapters[audioChapter];
  if (!item.chapters.length) return null;
  if (audio?.textChapter === null) return null;
  const textChapter = audio?.textChapter ?? Math.min(audioChapter, item.chapters.length - 1);
  const count = item.chapters[textChapter]?.sentences ?? 1;
  const fileStart = audio?.startMs ?? 0;
  const lead = audio?.leadInMs ?? 0;
  const tail = audio?.tailMs ?? 0;
  const local = positionMs - fileStart;
  if (local < lead) return null;
  const fileSpan = durationMs > fileStart ? durationMs - fileStart : durationMs;
  const body = Math.max(1, fileSpan - lead - tail);
  if (tail > 0 && local > lead + body) return null;
  const sentenceStart = audio?.sentenceStart ?? 0;
  const sentenceEnd = audio?.sentenceEnd ?? count;
  const slice = Math.max(1, sentenceEnd - sentenceStart);
  const sentence = Math.min(count - 1, sentenceStart + sentenceForProgress(slice, local - lead, body));
  return { chapter: textChapter, sentence };
}
