import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { SENTENCE_LEAD_MS } from '../src/lib/cues';
import { importEpubBytes, importFolioFiles } from '../src/lib/libraryStore';
import type { BookCueFile } from '../src/lib/libraryStore';
import { parseEpub } from '../src/lib/epub';
import { stripTags } from '../src/lib/html';
import { audioIndexForTextChapter } from '../src/lib/playback';
import { spokenAt } from '../src/lib/spoken';
import type { Cue, SeedAudioInfo } from '../src/lib/types';
import { memoryIo } from '../src/storage/memory';

type Timing = { sentence: number; startMs: number; endMs: number; words: { startMs: number; endMs: number }[] };

function cuesFrom(timings: Timing[], audio = 0, chapter = 0): Cue[] {
  return timings.map((row) => ({
    startMs: row.startMs,
    endMs: row.endMs,
    sentence: row.sentence,
    chapter,
    audio,
  }));
}

test('bundled book chapters follow their own cues and skip the preamble', async () => {
  const books = ['art-of-war', 'time-machine'] as const;
  for (const slug of books) {
    const info = JSON.parse(readFileSync(`assets/seed/books/${slug}/audio.json`, 'utf8')) as SeedAudioInfo;
    const distinct = new Map<number, number>();
    info.chapters.forEach((chapter, index) => {
      if (typeof chapter.textChapter === 'number') distinct.set(index, chapter.textChapter);
      if (!chapter.file) {
        assert.ok((chapter.leadInMs ?? 0) > 0, `${slug} ${index} trims the preamble`);
      }
    });
    if (slug === 'time-machine') {
      assert.equal(info.chapters[5].textChapter, null);
      assert.equal(info.chapters[7].textChapter, null);
      let previous = -1;
      for (const chapter of info.chapters) {
        if (chapter.textChapter == null) continue;
        assert.ok(chapter.textChapter >= previous, `${chapter.title} maps backwards`);
        previous = chapter.textChapter;
      }
    }
    const book = await parseEpub(new Uint8Array(readFileSync(`assets/seed/books/${slug}/book.epub`)));
    book.chapters.forEach((chapter, index) => {
      const audioIndex = audioIndexForTextChapter(info.chapters, index);
      if (audioIndex < 0) assert.equal(info.chapters.some((entry) => entry.textChapter === index), false);
      else assert.equal(info.chapters[audioIndex].textChapter, index);
    });
    if (slug === 'art-of-war') {
      const energy = book.chapters.find((chapter) => chapter.title.includes('Energy'));
      assert.ok(energy);
      assert.equal(energy.title.includes('272'), false);
      assert.equal(stripTags(energy.html).includes('Energy272'), false);
    }
    const cues: Cue[] = [];
    const cueFiles: Record<string, BookCueFile> = {};
    info.chapters.forEach((chapter, index) => {
      if (!chapter.cues) return;
      const file = JSON.parse(readFileSync(`assets/seed/books/${slug}/${chapter.cues}`, 'utf8')) as BookCueFile;
      cueFiles[chapter.cues] = file;
      for (const row of file.sentences) {
        cues.push({
          startMs: row.startMs,
          endMs: row.endMs,
          sentence: row.sentence,
          chapter: chapter.textChapter ?? 0,
          audio: index,
        });
      }
    });
    assert.ok(cues.length > 10, slug);
    for (const chapter of info.chapters) {
      if (!chapter.cues) continue;
      const index = info.chapters.indexOf(chapter);
      const first = cues.find((cue) => (cue.audio ?? 0) === index);
      if (first && first.startMs > 1000) {
        const mark = spokenAt(
          {
            sync: 'vtt',
            cues,
            chapters: info.chapters.map(() => ({ sentences: 400 })),
            audioChapters: info.chapters.map((entry) => ({ title: entry.title, textChapter: entry.textChapter, leadInMs: entry.leadInMs })),
          },
          index,
          Math.floor(first.startMs / 2),
          first.endMs + 1000,
        );
        assert.equal(mark, null, `${slug} preamble`);
      }
    }
    const bytes = new Uint8Array(readFileSync(`assets/seed/books/${slug}/book.epub`));
    const audioFiles: Record<string, Uint8Array> = {};
    for (const chapter of info.chapters) {
      if (chapter.file) audioFiles[chapter.file] = new Uint8Array(readFileSync(`assets/seed/books/${slug}/${chapter.file}`));
    }
    const item = await importEpubBytes(memoryIo(), bytes, { info, audioFiles, cueFiles });
    assert.equal(item.sync, 'vtt');
    assert.ok(item.cues.length > 10);
    assert.equal(item.cues.some((cue) => cue.words && cue.words.length > 0), false);
    assert.equal(item.audioChapters[0].textChapter, info.chapters[0].textChapter);
  }
});

test('sentence cues begin at the cue start, not before it', () => {
  const timings: Timing[] = [
    { sentence: 0, startMs: 0, endMs: 1200, words: [{ startMs: 0, endMs: 400 }, { startMs: 400, endMs: 1200 }] },
    { sentence: 1, startMs: 1600, endMs: 2800, words: [{ startMs: 1600, endMs: 2000 }, { startMs: 2000, endMs: 2800 }] },
    { sentence: 2, startMs: 2800, endMs: 4000, words: [{ startMs: 2800, endMs: 3400 }, { startMs: 3400, endMs: 4000 }] },
  ];
  const cues = cuesFrom(timings);
  const end = cues[cues.length - 1]?.endMs ?? 1;
  const item = {
    sync: 'vtt' as const,
    cues,
    chapters: [{ sentences: timings.length + 1 }],
    audioChapters: [{ title: 'Sample', textChapter: 0 }],
  };
  for (let index = 0; index < timings.length; index += 1) {
    const row = timings[index];
    assert.equal(row.startMs, row.words[0].startMs, `sentence ${row.sentence} start`);
    assert.equal(spokenAt(item, 0, row.startMs, end)?.sentence, row.sentence, `sentence ${row.sentence}`);
    if (index === 0) {
      continue;
    }
    const previous = timings[index - 1];
    const nextStart = row.startMs;
    if (nextStart - 120 > previous.endMs) {
      assert.equal(spokenAt(item, 0, nextStart - 120, end)?.sentence, previous.sentence, `pause before ${row.sentence}`);
    }
    assert.ok(SENTENCE_LEAD_MS <= 100);
    assert.equal(spokenAt(item, 0, nextStart, end)?.sentence, row.sentence, `sentence ${row.sentence} at its start`);
  }
});

test('time machine reaches Filby when that sentence starts', () => {
  const file = JSON.parse(readFileSync('assets/seed/books/time-machine/audio-00.cues.json', 'utf8')) as {
    sentences: { sentence: number; startMs: number; endMs: number; words: [number, number][] }[];
  };
  const filby = file.sentences.find((row) => row.sentence === 23);
  assert.ok(filby, 'sentence 23 is aligned');
  assert.equal(filby.startMs, filby.words[0][0]);
  assert.ok(filby.startMs > 120_200 && filby.startMs < 122_000);
  assert.ok(filby.endMs < 123_364);
  const cues: Cue[] = file.sentences.map((row) => ({
    startMs: row.startMs,
    endMs: row.endMs,
    sentence: row.sentence,
    chapter: 1,
    audio: 0,
  }));
  const item = {
    sync: 'vtt' as const,
    cues,
    chapters: [{ sentences: 1 }, { sentences: 206 }],
    audioChapters: [{ title: 'Chapter 1', textChapter: 1 }],
  };
  const at = (ms: number) => spokenAt(item, 0, ms, 600_000)?.sentence;
  assert.equal(at(120_200), 22);
  assert.equal(at(122_000), 23);
  assert.notEqual(at(122_000), 22);
  const fire = file.sentences.find((row) => row.sentence === 3);
  assert.ok(fire);
  assert.equal(fire.startMs, fire.words[0][0]);
  assert.ok(fire.startMs > 27_500 && fire.startMs < 28_200);
  assert.equal(at(27_000), 2);
  assert.equal(at(fire.startMs), 3);
});

test('the demo bundle follows the transcript without word timings', async () => {
  const root = 'assets/seed/demo/lamp';
  const files: Record<string, Uint8Array> = {};
  for (const name of ['folio.json', 'audio.mp3', 'captions.vtt', 'script.txt']) {
    files[name] = new Uint8Array(readFileSync(`${root}/${name}`));
  }
  const item = await importFolioFiles(memoryIo(), files);
  assert.equal(item.sync, 'vtt');
  assert.ok(item.cues.length > 3);
  assert.equal(item.cues.some((cue) => cue.words && cue.words.length > 0), false);
  assert.ok(item.cues.every((cue) => cue.endMs > cue.startMs));
  const first = item.cues[0];
  assert.equal(spokenAt(item, 0, first.startMs, first.endMs + 1000)?.sentence, first.sentence);
});
