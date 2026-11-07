import type { Cue, WordTime } from '@/lib/types';
import { wordStartMs, wordWeights, wordsOf } from '@/lib/timing';
import type { VttCue } from '@/lib/vtt';

export type WhisperWord = { start: number; end: number; word: string };

export type SentenceTiming = {
  sentence: number;
  startMs: number;
  endMs: number;
  words: WordTime[];
};

export function normalizeToken(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function similar(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.length >= 4 && right.length >= 4 && (left.startsWith(right) || right.startsWith(left))) return true;
  if (Math.abs(left.length - right.length) > 1 || left.length < 4) return false;
  if (left.length === right.length) {
    let edits = 0;
    for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) edits += 1;
    return edits <= 1;
  }
  const [shorter, longer] = left.length < right.length ? [left, right] : [right, left];
  let i = 0;
  let j = 0;
  let skips = 0;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i += 1;
      j += 1;
    } else {
      skips += 1;
      j += 1;
      if (skips > 1) return false;
    }
  }
  return true;
}

/** Map each script token onto a heard token index, or null when the narration skipped it. */
export function alignTokenIndexes(script: string[], heard: string[]): Array<number | null> {
  const n = script.length;
  const m = heard.length;
  const map: Array<number | null> = Array.from({ length: n }, () => null);
  if (!n || !m) return map;
  const cols = m + 1;
  const score = new Int32Array((n + 1) * cols);
  const back = new Uint8Array((n + 1) * cols);
  const at = (i: number, j: number) => i * cols + j;
  const gap = -1;
  for (let i = 1; i <= n; i += 1) {
    score[at(i, 0)] = i * gap;
    back[at(i, 0)] = 2;
  }
  for (let j = 1; j <= m; j += 1) {
    score[at(0, j)] = j * gap;
    back[at(0, j)] = 3;
  }
  for (let i = 1; i <= n; i += 1) {
    const token = script[i - 1];
    for (let j = 1; j <= m; j += 1) {
      const heardToken = heard[j - 1];
      const match = token === heardToken ? 3 : similar(token, heardToken) ? 1 : -2;
      const diag = score[at(i - 1, j - 1)] + match;
      const up = score[at(i - 1, j)] + gap;
      const left = score[at(i, j - 1)] + gap;
      let best = diag;
      let dir = 1;
      if (up > best) {
        best = up;
        dir = 2;
      }
      if (left > best) {
        best = left;
        dir = 3;
      }
      score[at(i, j)] = best;
      back[at(i, j)] = dir;
    }
  }
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const dir = back[at(i, j)] || (i > 0 ? 2 : 3);
    if (dir === 1) {
      i -= 1;
      j -= 1;
      if (script[i] === heard[j] || similar(script[i], heard[j])) map[i] = j;
    } else if (dir === 2) i -= 1;
    else j -= 1;
    if (i === 0 && j === 0) break;
  }
  return map;
}

function proportionalWords(sentence: string, startMs: number, endMs: number): WordTime[] {
  const words = wordsOf(sentence);
  const weights = wordWeights(words);
  const span = Math.max(1, endMs - startMs);
  return words.map((_, index) => {
    const start = startMs + wordStartMs(weights, index, span);
    const end = startMs + wordStartMs(weights, index + 1, span);
    return { startMs: Math.round(start), endMs: Math.round(Math.max(end, start + 1)) };
  });
}

function finishWords(words: Array<WordTime | null>, startMs: number, endMs: number): WordTime[] {
  const known = words.flatMap((word, index) => (word ? [{ index, word }] : []));
  if (!known.length) return proportionalWords('', startMs, endMs);
  const filled: WordTime[] = words.map((word) => word ?? { startMs: 0, endMs: 0 });
  for (let index = 0; index < filled.length; index += 1) {
    if (words[index]) continue;
    const before = known.filter((entry) => entry.index < index).at(-1);
    const after = known.find((entry) => entry.index > index);
    if (before && after) {
      const gap = after.index - before.index;
      const step = (after.word.startMs - before.word.endMs) / gap;
      const start = before.word.endMs + step * (index - before.index);
      filled[index] = { startMs: Math.round(start), endMs: Math.round(start + Math.max(1, step)) };
    } else if (before) {
      const start = before.word.endMs;
      filled[index] = { startMs: Math.round(start), endMs: Math.round(start + 1) };
    } else if (after) {
      const end = after.word.startMs;
      filled[index] = { startMs: Math.round(Math.max(startMs, end - 1)), endMs: Math.round(end) };
    }
  }
  for (let index = 0; index < filled.length; index += 1) {
    // The first word keeps its aligned start. A later cue boundary must not push it.
    const prev = index > 0 ? filled[index - 1].endMs : filled[index].startMs;
    const start = Math.max(prev, filled[index].startMs);
    const next = index + 1 < filled.length ? filled[index + 1].startMs : endMs;
    const end = Math.max(start + 1, Math.min(Math.max(filled[index].endMs, start + 1), Math.max(next, start + 1)));
    filled[index] = { startMs: Math.round(start), endMs: Math.round(end) };
  }
  return filled;
}

/** Place one sentence's words on whisper timestamps inside a known window. */
export function timeSentence(sentence: string, window: WhisperWord[], startMs: number, endMs: number): WordTime[] {
  const raw = wordsOf(sentence);
  if (!raw.length) return [];
  const script = raw.map((word) => normalizeToken(word));
  const heard = window.map((word) => normalizeToken(word.word)).filter(Boolean);
  const heardWords = window.filter((word) => normalizeToken(word.word));
  const usable = script.filter(Boolean);
  if (!heard.length || !usable.length) return proportionalWords(sentence, startMs, endMs);
  const mapping = alignTokenIndexes(usable, heard);
  const matched = mapping.filter((index) => index != null).length;
  if (matched / usable.length < 0.45) return proportionalWords(sentence, startMs, endMs);
  const placed: Array<WordTime | null> = raw.map(() => null);
  let usableIndex = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (!script[index]) continue;
    const heardIndex = mapping[usableIndex];
    usableIndex += 1;
    if (heardIndex == null) continue;
    const word = heardWords[heardIndex];
    placed[index] = { startMs: Math.round(word.start * 1000), endMs: Math.round(word.end * 1000) };
  }
  return finishWords(placed, startMs, endMs);
}

export function alignCuesToSentences(cues: VttCue[], sentences: string[], chapter = 0, audio = 0): Cue[] {
  const scriptWords: { sentence: number; norm: string }[] = [];
  sentences.forEach((sentence, sentenceIndex) => {
    for (const word of wordsOf(sentence)) {
      const norm = normalizeToken(word);
      if (norm) scriptWords.push({ sentence: sentenceIndex, norm });
    }
  });
  const cueWords: { norm: string; startMs: number; endMs: number }[] = [];
  for (const cue of cues) {
    const words = wordsOf(cue.text);
    const weights = wordWeights(words);
    const span = Math.max(1, cue.endMs - cue.startMs);
    words.forEach((word, index) => {
      const norm = normalizeToken(word);
      if (!norm) return;
      const start = cue.startMs + wordStartMs(weights, index, span);
      const end = cue.startMs + wordStartMs(weights, index + 1, span);
      cueWords.push({ norm, startMs: start, endMs: Math.max(end, start + 1) });
    });
  }
  if (!scriptWords.length || !cueWords.length) return [];
  const mapping = alignTokenIndexes(
    scriptWords.map((word) => word.norm),
    cueWords.map((word) => word.norm),
  );
  const bySentence = new Map<number, { startMs: number; endMs: number; matched: number; total: number }>();
  scriptWords.forEach((word, index) => {
    const bucket = bySentence.get(word.sentence) ?? { startMs: Number.POSITIVE_INFINITY, endMs: 0, matched: 0, total: 0 };
    bucket.total += 1;
    const heard = mapping[index];
    if (heard != null) {
      bucket.matched += 1;
      bucket.startMs = Math.min(bucket.startMs, cueWords[heard].startMs);
      bucket.endMs = Math.max(bucket.endMs, cueWords[heard].endMs);
    }
    bySentence.set(word.sentence, bucket);
  });
  const aligned: Cue[] = [];
  for (const [sentence, bucket] of bySentence) {
    if (!bucket.matched || bucket.matched / bucket.total < 0.45) continue;
    aligned.push({
      startMs: Math.round(bucket.startMs),
      endMs: Math.round(Math.max(bucket.endMs, bucket.startMs + 1)),
      sentence,
      chapter,
      audio,
    });
  }
  aligned.sort((a, b) => a.startMs - b.startMs || a.sentence - b.sentence);
  return aligned;
}

/** Attach whisper word times to sentence cues. Missing timings stay proportional at playback. */
export function timingsFromWhisper(sentences: string[], cues: Cue[], whisper: WhisperWord[]): SentenceTiming[] {
  return cues.map((cue) => {
    const sentence = sentences[cue.sentence] ?? '';
    const window = whisper.filter((word) => {
      const mid = ((word.start + word.end) / 2) * 1000;
      return mid >= cue.startMs - 400 && mid <= cue.endMs + 400;
    });
    const words = timeSentence(sentence, window, cue.startMs, cue.endMs);
    const startMs = words[0]?.startMs ?? cue.startMs;
    const endMs = words[words.length - 1]?.endMs ?? cue.endMs;
    return { sentence: cue.sentence, startMs, endMs, words };
  });
}

export type ChapterAnchor = {
  chapter: number;
  sentence: number;
  leadInMs: number;
  score: number;
};

/** Find which text chapter a recording starts in, and when the book text begins. */
export function openingAnchor(chapters: { sentences: string[] }[], whisper: WhisperWord[]): ChapterAnchor | null {
  const heard = whisper.map((word) => normalizeToken(word.word)).filter(Boolean).slice(0, 80);
  if (heard.length < 8) return null;
  let best: ChapterAnchor | null = null;
  for (let chapterIndex = 0; chapterIndex < chapters.length; chapterIndex += 1) {
    const chapter = chapters[chapterIndex];
    const tokens: { norm: string; sentence: number }[] = [];
    chapter.sentences.forEach((sentence, sentenceIndex) => {
      for (const word of wordsOf(sentence)) {
        const norm = normalizeToken(word);
        if (norm) tokens.push({ norm, sentence: sentenceIndex });
      }
    });
    if (tokens.length < 8) continue;
    const width = Math.min(10, heard.length, tokens.length);
    const heardWords = whisper.filter((word) => normalizeToken(word.word));
    for (let heardStart = 0; heardStart + width <= Math.min(heard.length, 48); heardStart += 2) {
      for (let start = 0; start + width <= tokens.length; start += 1) {
        let score = 0;
        for (let offset = 0; offset < width; offset += 1) {
          if (tokens[start + offset].norm === heard[heardStart + offset]) score += 1;
        }
        if (!best || score > best.score) {
          best = {
            chapter: chapterIndex,
            sentence: tokens[start].sentence,
            leadInMs: Math.round((heardWords[heardStart]?.start ?? 0) * 1000),
            score,
          };
        }
      }
    }
  }
  if (!best || best.score < 6) return null;
  return best;
}

/** Align a whole chapter's sentences to one recording's whisper words. */
export function alignChapterWhisper(sentences: string[], whisper: WhisperWord[], chapter: number, audio = 0): Cue[] {
  const script: { sentence: number; word: number; norm: string }[] = [];
  sentences.forEach((sentence, sentenceIndex) => {
    wordsOf(sentence).forEach((word, wordIndex) => {
      const norm = normalizeToken(word);
      if (norm) script.push({ sentence: sentenceIndex, word: wordIndex, norm });
    });
  });
  const heardWords = whisper.filter((word) => normalizeToken(word.word));
  const heard = heardWords.map((word) => normalizeToken(word.word));
  if (!script.length || !heard.length) return [];
  const mapping = alignTokenIndexes(
    script.map((word) => word.norm),
    heard,
  );
  const grouped = new Map<number, Array<WordTime | null>>();
  sentences.forEach((_, index) => grouped.set(index, wordsOf(sentences[index]).map(() => null)));
  const matchedCount = new Map<number, number>();
  script.forEach((word, index) => {
    const heardIndex = mapping[index];
    if (heardIndex == null) return;
    const row = grouped.get(word.sentence);
    if (!row) return;
    const spoken = heardWords[heardIndex];
    row[word.word] = { startMs: Math.round(spoken.start * 1000), endMs: Math.round(spoken.end * 1000) };
    matchedCount.set(word.sentence, (matchedCount.get(word.sentence) ?? 0) + 1);
  });
  const cues: Cue[] = [];
  sentences.forEach((sentence, index) => {
    const raw = wordsOf(sentence);
    const content = raw.map(normalizeToken).filter(Boolean).length;
    const matched = matchedCount.get(index) ?? 0;
    if (!content || matched / content < 0.45) return;
    const startMs = grouped.get(index)?.find((word) => word)?.startMs ?? 0;
    const endGuess = [...(grouped.get(index) ?? [])].reverse().find((word) => word)?.endMs ?? startMs + 1;
    const words = finishWords(grouped.get(index) ?? [], startMs, endGuess);
    if (!words.length) return;
    cues.push({
      startMs: words[0].startMs,
      endMs: Math.max(words[words.length - 1].endMs, words[0].startMs + 1),
      sentence: index,
      chapter,
      audio,
      words,
    });
  });
  return cues;
}

export function cuesFromTimings(timings: SentenceTiming[], chapter: number, audio = 0): Cue[] {
  return timings
    .filter((row) => row.words.length)
    .map((row) => ({
      startMs: row.startMs,
      endMs: Math.max(row.endMs, row.startMs + 1),
      sentence: row.sentence,
      chapter,
      audio,
      words: row.words,
    }));
}
