import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { sentencesFromHtml } from '../src/lib/htmlSentences';
import { parseEpub } from '../src/lib/epub';
import type { SeedAudioInfo } from '../src/lib/types';

const ROOT = path.resolve(import.meta.dirname, '..');

type Word = { startMs: number; endMs: number };
type Row = { sentence: number; startMs: number; endMs: number; words: Word[]; score?: number };

const FALLBACK: Record<string, Array<number | null>> = {
  'art-of-war': [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
  'time-machine': [1, 2, 3, 4, 5, null, 7, null, 9, 10, 11, 12, null, null, null, null, 13],
};

function pack(rows: Row[]): Row[] {
  const sorted = rows.filter((row) => row.words?.length).sort((a, b) => a.startMs - b.startMs || a.sentence - b.sentence);
  for (const row of sorted) {
    let prev = row.words[0].startMs;
    for (const word of row.words) {
      const start = Math.max(prev, word.startMs);
      const end = Math.max(start + 1, word.endMs);
      word.startMs = start;
      word.endMs = end;
      prev = end;
    }
    row.startMs = row.words[0].startMs;
    row.endMs = Math.max(row.words[row.words.length - 1].endMs, row.startMs + 1);
  }
  return sorted;
}

function localFile(slug: string, chapter: { file?: string; url: string }): string | null {
  if (chapter.file) {
    const bundled = path.join(ROOT, 'assets/seed/books', slug, chapter.file);
    if (existsSync(bundled)) return bundled;
  }
  const remote = path.join('/tmp/librivox', slug, path.basename(chapter.url));
  return existsSync(remote) ? remote : null;
}

function durationMs(file: string): number {
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const seconds = Number(probe.stdout.trim());
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0;
}

async function queueBooks(): Promise<void> {
  const full: unknown[] = [];
  const probes: unknown[] = [];
  for (const slug of Object.keys(FALLBACK)) {
    const dir = path.join(ROOT, 'assets/seed/books', slug);
    const info = JSON.parse(readFileSync(path.join(dir, 'audio.json'), 'utf8')) as SeedAudioInfo;
    const book = await parseEpub(new Uint8Array(readFileSync(path.join(dir, 'book.epub'))));
    const chapters = book.chapters.map((chapter) => ({ title: chapter.title, sentences: sentencesFromHtml(chapter.html) }));
    const openings: { id: string; sentences: string[] }[] = [];
    chapters.forEach((chapter, index) => {
      if (index === 0 || /colophon/i.test(chapter.title)) return;
      const slice = chapter.sentences.slice(0, 6).filter(Boolean);
      if (slice.length) openings.push({ id: `${index}@0`, sentences: slice });
    });
    info.chapters.forEach((chapter, index) => {
      const audio = localFile(slug, chapter);
      if (!audio) {
        console.log('missing audio', slug, index);
        return;
      }
      const fallback = FALLBACK[slug][index] ?? null;
      const bundled = Boolean(chapter.file) && fallback != null;
      if (bundled && fallback != null) {
        full.push({
          audio,
          out: `/tmp/align/${slug}-${index}.json`,
          sentences: chapters[fallback].sentences,
        });
      }
      const dense = new Set<number>();
      for (const neighbor of [fallback, FALLBACK[slug][index - 1], FALLBACK[slug][index + 1]]) {
        if (neighbor != null) dense.add(neighbor);
      }
      if (fallback == null) {
        chapters.forEach((entry, entryIndex) => {
          if (entryIndex > 0 && entry.sentences.length < 400) dense.add(entryIndex);
        });
      }
      if (bundled) return;
      const candidates = openings.map((item) => ({ ...item, sentences: [...item.sentences] }));
      for (const entryIndex of dense) {
        const entry = chapters[entryIndex];
        if (!entry || /colophon/i.test(entry.title)) continue;
        const step = /endnotes/i.test(entry.title) ? entry.sentences.length : 8;
        for (let start = 0; start < entry.sentences.length; start += step) {
          if (start === 0) continue;
          const slice = entry.sentences.slice(start, start + 6).filter(Boolean);
          if (slice.length) candidates.push({ id: `${entryIndex}@${start}`, sentences: slice });
        }
      }
      probes.push({
        mode: 'probe',
        audio,
        out: `/tmp/align/${slug}-${index}-probe.json`,
        headSeconds: 80,
        tailSeconds: 22,
        candidates,
      });
    });
  }
  writeFileSync('/tmp/align/books-full.json', JSON.stringify(full));
  writeFileSync('/tmp/align/books-probe.json', JSON.stringify(probes));
  console.log('queued full', full.length, 'probes', probes.length);
}

type Probe = {
  durationMs: number;
  tailMs: number;
  introEndMs: number | null;
  candidates: { id: string; kept: number; mean: number; leadInMs: number | null; sentence: number | null; endMs: number | null }[];
};

function candidateChapter(id: string): number {
  return Number(id.split('@')[0]);
}

function candidateSentence(item: { id: string; sentence: number | null }): number {
  return Number(item.id.split('@')[1]) + (item.sentence ?? 0);
}

function pickProbe(probe: Probe, fallback: number | null): { textChapter: number | null; sentence: number; leadInMs: number; mean: number } {
  const viable = probe.candidates.filter((item) => {
    if (item.leadInMs == null || item.sentence == null) return false;
    const chapter = candidateChapter(item.id);
    const offset = Number(item.id.split('@')[1]);
    if (chapter === fallback && offset === 0 && item.kept >= 3 && item.mean >= 0.75) return true;
    if (chapter === fallback && offset > 0 && item.kept >= 5 && item.mean >= 0.93) return true;
    // A different chapter has to be unmistakable. Short slices false-match around 0.85.
    if (chapter !== fallback && offset === 0 && item.kept >= 4 && item.mean >= 0.92) return true;
    if (chapter !== fallback && offset > 0 && item.kept >= 5 && item.mean >= 0.94) return true;
    return false;
  });
  const byQuality = (a: (typeof viable)[number], b: (typeof viable)[number]) => b.mean - a.mean || a.kept - b.kept;
  const fallbackHit = viable.filter((item) => candidateChapter(item.id) === fallback).sort(byQuality)[0];
  const best = viable.slice().sort(byQuality)[0];
  let chosen = fallbackHit && best && best.mean - fallbackHit.mean < 0.04 ? fallbackHit : best;
  if (chosen) {
    const earlier = viable
      .filter((item) => candidateChapter(item.id) === candidateChapter(chosen.id) && candidateSentence(item) < candidateSentence(chosen) && chosen.mean - item.mean < 0.05)
      .sort((a, b) => candidateSentence(a) - candidateSentence(b))[0];
    if (earlier) chosen = earlier;
  }
  if (!chosen || chosen.leadInMs == null || chosen.sentence == null) {
    const intro = probe.introEndMs && probe.introEndMs > 800 && probe.introEndMs < 25_000 ? probe.introEndMs : 20_000;
    return { textChapter: fallback, sentence: 0, leadInMs: intro, mean: 0 };
  }
  const textChapter = Number(chosen.id.split('@')[0]);
  const offset = Number(chosen.id.split('@')[1]);
  return { textChapter, sentence: offset + chosen.sentence, leadInMs: chosen.leadInMs, mean: chosen.mean };
}

async function applyBooks(): Promise<void> {
  for (const slug of Object.keys(FALLBACK)) {
    const dir = path.join(ROOT, 'assets/seed/books', slug);
    const info = JSON.parse(readFileSync(path.join(dir, 'audio.json'), 'utf8')) as SeedAudioInfo;
    const book = await parseEpub(new Uint8Array(readFileSync(path.join(dir, 'book.epub'))));
    const counts = book.chapters.map((chapter) => sentencesFromHtml(chapter.html).length);
    const chosen: { textChapter: number | null; sentence: number; leadInMs: number }[] = [];
    info.chapters.forEach((chapter, index) => {
      const fallback = FALLBACK[slug][index] ?? null;
      const fullPath = `/tmp/align/${slug}-${index}.json`;
      const probePath = `/tmp/align/${slug}-${index}-probe.json`;
      const probe = existsSync(probePath) ? (JSON.parse(readFileSync(probePath, 'utf8')) as Probe) : null;
      const full = existsSync(fullPath) ? pack(JSON.parse(readFileSync(fullPath, 'utf8')) as Row[]) : null;
      const fullMean = full?.length ? (JSON.parse(readFileSync(fullPath, 'utf8')) as Row[]).reduce((sum, row) => sum + (row.score ?? 0), 0) / (JSON.parse(readFileSync(fullPath, 'utf8')) as Row[]).length : 0;
      const expected = fallback == null ? 0 : counts[fallback];
      const acceptFull = Boolean(full && full.length >= 8 && fullMean >= 0.85);
      if (acceptFull && full && fallback != null) {
        const cueName = `audio-${String(index).padStart(2, '0')}.cues.json`;
        const payload = {
          sentences: full.map((row) => ({
            sentence: row.sentence,
            startMs: row.startMs,
            endMs: row.endMs,
          })),
        };
        writeFileSync(path.join(dir, cueName), JSON.stringify(payload));
        const span = probe?.durationMs || durationMs(localFile(slug, chapter) || '');
        const tail = Math.max(0, span - full[full.length - 1].endMs);
        chapter.cues = cueName;
        chapter.textChapter = fallback;
        chapter.leadInMs = full[0].startMs;
        chapter.tailMs = tail > 800 ? tail : 0;
        chapter.sentenceStart = full[0].sentence;
        chapter.sentenceEnd = full[full.length - 1].sentence + 1;
        chosen.push({ textChapter: fallback, sentence: full[0].sentence, leadInMs: full[0].startMs });
        console.log('cues', slug, index, 'chapter', fallback, 'rows', full.length, 'lead', chapter.leadInMs, 'tail', chapter.tailMs, 'mean', fullMean.toFixed(3));
        return;
      }
      const pick = probe ? pickProbe(probe, fallback) : { textChapter: fallback, sentence: 0, leadInMs: 20000, mean: 0 };
      chapter.textChapter = pick.textChapter;
      chapter.leadInMs = Math.max(1, pick.leadInMs);
      chapter.sentenceStart = pick.textChapter == null ? undefined : pick.sentence;
      chapter.tailMs = probe && probe.tailMs > 800 ? probe.tailMs : undefined;
      delete chapter.cues;
      chosen.push({ textChapter: pick.textChapter, sentence: pick.sentence, leadInMs: pick.leadInMs });
      console.log('map', slug, index, 'chapter', pick.textChapter, 'sentence', pick.sentence, 'lead', chapter.leadInMs, 'tail', chapter.tailMs ?? 0, 'mean', pick.mean.toFixed(3));
    });
    info.chapters.forEach((chapter, index) => {
      if (chapter.cues || chapter.textChapter == null) return;
      const next = chosen.slice(index + 1).find((entry) => entry.textChapter === chapter.textChapter && entry.sentence > (chapter.sentenceStart ?? 0));
      chapter.sentenceEnd = next ? next.sentence : counts[chapter.textChapter];
    });
    writeFileSync(path.join(dir, 'audio.json'), `${JSON.stringify(info, null, 2)}\n`);
    console.log('wrote', slug);
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'queue-books';
  if (command === 'queue-books') {
    await queueBooks();
  } else if (command === 'apply-books') {
    await applyBooks();
  } else {
    throw new Error('use queue-books | apply-books');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
