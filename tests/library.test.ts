import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { alignAudioToText } from '../src/lib/alignChapters';
import { alignCues, cueAt, sentenceForProgress } from '../src/lib/cues';
import { parseEpub } from '../src/lib/epub';
import { audioFromGeminiResponse, classifyGeminiFailure } from '../src/lib/gemini';
import { wrapSentences } from '../src/lib/html';
import { attachAudio, importFolioFiles, readLibrary, updateItem, writeLibrary } from '../src/lib/libraryStore';
import { m4bChapters } from '../src/lib/m4b';
import { parseFolioManifest } from '../src/lib/manifest';
import { splitSentences } from '../src/lib/sentences';
import { cuesToSentences, parseVtt } from '../src/lib/vtt';
import type { LibraryItem } from '../src/lib/types';
import { bytesToBase64, isWav, pcmToWav } from '../src/lib/wav';
import { memoryIo } from '../src/storage/memory';

function shelfItem(id: string, title: string): LibraryItem {
  return {
    id,
    kind: 'book',
    title,
    author: 'Author',
    createdAt: 1,
    lastOpenedAt: null,
    progress: 0,
    locator: { chapter: 0, page: 0, sentence: 0, scroll: 0 },
    audioPositionMs: 0,
    audioChapter: 1,
    hasAudio: true,
    hasText: true,
    sync: 'approximate',
    chapters: [{ title: 'I', sentences: 4 }],
    audioChapters: [{ title: 'Audio', textChapter: 0 }],
    cues: [],
  };
}

test('sentences keep abbreviations', () => {
  const sentences = splitSentences('Dr. Wells arrived at 9 a.m. He left.');
  assert.equal(sentences.length, 2);
  assert.match(sentences[0], /^Dr\. Wells/);
});

test('vtt accepts comma and dot timestamps', () => {
  const cues = parseVtt(`WEBVTT

1
00:00:01.000 --> 00:00:02.500
Hello there.

00:00:02,500 --> 00:00:04,000
Second line.
`);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].startMs, 1000);
  assert.equal(cues[0].endMs, 2500);
  assert.equal(cues[1].startMs, 2500);
  assert.equal(cues[1].endMs, 4000);
  assert.equal(cues[1].text, 'Second line.');
  const spaced = parseVtt('WEBVTT\n\n00:00:00.000 --> 00:00:07.675\nHello there friend.\n');
  assert.equal(spaced[0].startMs, 0);
  assert.equal(spaced[0].endMs, 7675);
});

test('wav wraps raw pcm', () => {
  const wav = pcmToWav(new Uint8Array(4800), 24000);
  assert.equal(isWav(wav), true);
  const restored = audioFromGeminiResponse({ type: 'audio', mimeType: 'audio/wav', data: bytesToBase64(wav) });
  assert.equal(isWav(restored), true);
  const quota = classifyGeminiFailure(429, '{"error":{"status":"RESOURCE_EXHAUSTED","message":"quota"}}');
  assert.equal(quota.quota, true);
  assert.equal(quota.retryable, true);
});

test('folio manifest requires version 1', () => {
  const manifest = parseFolioManifest(JSON.stringify({ folio: 1, title: 'A Lamp in the Window', audio: 'a.mp3' }));
  assert.equal(manifest.title, 'A Lamp in the Window');
  assert.throws(() => parseFolioManifest('{"folio":2,"title":"no"}'), /folio: 1/);
});

test('concurrent library patches keep every field', async () => {
  const io = memoryIo();
  const readText = io.readText.bind(io);
  io.readText = async (path) => {
    const value = await readText(path);
    if (path === 'library.json') await new Promise((resolve) => setTimeout(resolve, 25));
    return value;
  };
  const first = shelfItem('a', 'The Time Machine');
  const second = { ...shelfItem('b', 'Field Notes'), audioChapter: 2 };
  await writeLibrary(io, { items: [first, second] });
  await Promise.all([
    updateItem(io, 'a', { locator: { chapter: 9, page: 0, sentence: 3, scroll: 0.4 }, progress: 0.8 }),
    updateItem(io, 'a', { audioPositionMs: 2200, audioChapter: 6 }),
    updateItem(io, 'b', { progress: 0.3 }),
  ]);
  const saved = await readLibrary(io);
  const a = saved.items.find((item) => item.id === 'a');
  const b = saved.items.find((item) => item.id === 'b');
  assert.equal(a?.locator?.chapter, 9);
  assert.equal(a?.locator?.sentence, 3);
  assert.equal(a?.locator?.scroll, 0.4);
  assert.equal(a?.progress, 0.8);
  assert.equal(a?.audioChapter, 6);
  assert.equal(a?.audioPositionMs, 2200);
  assert.equal(a?.title, 'The Time Machine');
  assert.equal(b?.progress, 0.3);
  assert.equal(b?.audioChapter, 2);
  assert.equal(b?.title, 'Field Notes');
});

test('an earlier item save still in flight cannot erase a later chapter pick', async () => {
  const files = new Map<string, string>();
  let arm = false;
  let writes = 0;
  const io = memoryIo();
  let tail = Promise.resolve();
  io.readText = async (path) => files.get(path) ?? null;
  io.writeText = async (path, text) => {
    if (!arm || path !== 'library.json') {
      files.set(path, text);
      return;
    }
    const delay = writes === 0 ? 40 : 5;
    writes += 1;
    await new Promise((resolve) => setTimeout(resolve, 0));
    setTimeout(() => {
      files.set(path, text);
    }, delay);
  };
  io.mutateText = (path, update) => {
    const run = tail.then(async () => {
      const next = update(files.get(path) ?? null);
      await new Promise((resolve) => setTimeout(resolve, 15));
      files.set(path, next);
    });
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  const timeMachine = shelfItem('tm', 'The Time Machine');
  timeMachine.locator = { chapter: 1, page: 0, sentence: 0, scroll: 0 };
  timeMachine.audioChapter = 0;
  const art = shelfItem('aow', 'The Art of War');
  await writeLibrary(io, { items: [art, timeMachine] });
  arm = true;
  await Promise.all([
    updateItem(io, 'aow', { progress: 0.42, audioChapter: 3 }),
    updateItem(io, 'tm', {
      locator: { chapter: 6, page: 0, sentence: 0, scroll: 0 },
      audioChapter: 8,
      progress: 0.5,
    }),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const saved = await readLibrary(io);
  const tm = saved.items.find((item) => item.id === 'tm');
  const aow = saved.items.find((item) => item.id === 'aow');
  assert.equal(tm?.locator?.chapter, 6);
  assert.equal(tm?.audioChapter, 8);
  assert.equal(tm?.progress, 0.5);
  assert.equal(aow?.progress, 0.42);
  assert.equal(aow?.audioChapter, 3);
  assert.equal(aow?.locator?.chapter, 0);
  assert.equal(tm?.title, 'The Time Machine');
});

test('linking audio onto a book drops the old transcript', async () => {
  const io = memoryIo();
  const book = {
    id: 'book',
    kind: 'book' as const,
    title: 'The Time Machine',
    author: 'H. G. Wells',
    createdAt: 1,
    lastOpenedAt: null,
    progress: 0.4,
    locator: { chapter: 3, page: 0, sentence: 2, scroll: 0.2 },
    audioPositionMs: 1000,
    audioChapter: 1,
    hasAudio: true,
    hasText: true,
    sync: 'vtt' as const,
    chapters: [
      { title: 'I', sentences: 10 },
      { title: 'II', sentences: 10 },
    ],
    audioChapters: [{ title: 'old', textChapter: 0, file: 'old.mp3' }],
    cues: [{ startMs: 0, endMs: 1000, sentence: 1, chapter: 0, audio: 0 }],
  };
  const audio = {
    ...book,
    id: 'audio',
    kind: 'audiobook' as const,
    title: 'A reading',
    hasText: false,
    sync: 'none' as const,
    chapters: [],
    cues: [],
    audioChapters: [
      { title: 'Second', textChapter: null },
      { title: 'First', textChapter: null },
    ],
  };
  await writeLibrary(io, { items: [book, audio] });
  const linked = await attachAudio(io, 'book', 'audio');
  assert.ok(linked);
  assert.equal(linked.sync, 'approximate');
  assert.equal(linked.cues.length, 0);
  assert.equal(linked.audioChapters.length, 2);
  assert.equal(linked.audioChapters[0].title, 'Second');
  const stored = await readLibrary(io);
  assert.equal(stored.items.find((item) => item.id === 'book')?.cues.length, 0);
});

test('html wraps one span per sentence', () => {
  const wrapped = wrapSentences('<p>One sentence. Two sentences.</p>');
  assert.equal(wrapped.count, 2);
  assert.match(wrapped.html, /data-i="0"/);
  assert.match(wrapped.html, /data-i="1"/);
  assert.equal(wrapped.html.includes('data-w'), false);
});

test('m4b reads a nero chapter list', () => {
  const title = new TextEncoder().encode('Intro');
  const payload = new Uint8Array(8 + 1 + 8 + 1 + title.length);
  payload[8] = 1;
  const view = new DataView(payload.buffer);
  view.setUint32(9, 0);
  view.setUint32(13, 5_000_000);
  payload[17] = title.length;
  payload.set(title, 18);
  const atom = new Uint8Array(8 + payload.length);
  const header = new DataView(atom.buffer);
  header.setUint32(0, atom.length);
  atom.set([...'chpl'].map((char) => char.charCodeAt(0)), 4);
  atom.set(payload, 8);
  const chapters = m4bChapters(atom);
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].title, 'Intro');
  assert.equal(chapters[0].startMs, 500);
});

test('cue alignment and progress', () => {
  const cues = alignCues(
    [
      { startMs: 0, endMs: 1000, text: 'A.' },
      { startMs: 1000, endMs: 2000, text: 'B.' },
    ],
    2,
  );
  assert.equal(cueAt(cues, 1500)?.sentence, 1);
  assert.equal(cueAt([{ startMs: 400, endMs: 800, sentence: 0, chapter: 0 }], 100), null);
  assert.equal(sentenceForProgress(4, 500, 1000), 2);
});

test('audiobook tracks skip the imprint and land on the matching chapter', async () => {
  const bytes = new Uint8Array(readFileSync('assets/seed/books/time-machine/book.epub'));
  const book = await parseEpub(bytes);
  const audio = JSON.parse(readFileSync('assets/seed/books/time-machine/audio.json', 'utf8')) as { chapters: { title: string }[] };
  const indexes = alignAudioToText(
    audio.chapters.map((chapter) => chapter.title),
    book.chapters.map((chapter) => chapter.title),
  );
  assert.notEqual(book.chapters[indexes[0]].title, 'Frontmatter');
  assert.ok(book.chapters[indexes[0]].sentences > 40);

  const warBytes = new Uint8Array(readFileSync('assets/seed/books/art-of-war/book.epub'));
  const war = await parseEpub(warBytes);
  const warAudio = JSON.parse(readFileSync('assets/seed/books/art-of-war/audio.json', 'utf8')) as { chapters: { title: string }[] };
  const warIndexes = alignAudioToText(
    warAudio.chapters.map((chapter) => chapter.title),
    war.chapters.map((chapter) => chapter.title),
  );
  assert.match(war.chapters[warIndexes[0]].title, /Art of War/i);
  assert.match(war.chapters[warIndexes[1]].title, /Waging War/i);
  assert.match(war.chapters[warIndexes[12]].title, /Spies/i);
});

test('time machine epub parses into chapters', async () => {
  const bytes = new Uint8Array(readFileSync('assets/seed/books/time-machine/book.epub'));
  const book = await parseEpub(bytes);
  assert.match(book.title, /Time Machine/i);
  assert.ok(book.chapters.length > 2);
  assert.ok(book.chapters.some((chapter) => chapter.sentences > 5));
});

test('a demo audio bundle imports with sentence cues', async () => {
  const root = 'assets/seed/demo/lamp';
  const files: Record<string, Uint8Array> = {
    'folio.json': new Uint8Array(readFileSync(`${root}/folio.json`)),
    'audio.mp3': new Uint8Array(readFileSync(`${root}/audio.mp3`)),
    'captions.vtt': new Uint8Array(readFileSync(`${root}/captions.vtt`)),
    'script.txt': new Uint8Array(readFileSync(`${root}/script.txt`)),
  };
  const io = memoryIo();
  const item = await importFolioFiles(io, files);
  assert.equal(item.collection, undefined);
  assert.equal(item.author, 'Folio demo');
  assert.equal(item.title, 'A Lamp in the Window');
  assert.equal(item.sync, 'vtt');
  assert.equal(item.hasAudio, true);
  assert.equal(item.hasText, true);
  assert.equal(item.bundledAudio, true);
  assert.equal(item.cues.length, 8);
  assert.equal(item.cues.some((cue) => cue.words && cue.words.length > 0), false);
  assert.equal(item.cues[0].sentence, 0);
  assert.equal(item.cues[1].sentence, 1);
  assert.ok(item.cues[0].endMs > item.cues[0].startMs);
  assert.ok(item.cues[1].startMs >= item.cues[0].endMs - 1);
  const spoken = cuesToSentences(parseVtt(new TextDecoder().decode(files['captions.vtt'])));
  assert.equal(spoken.length, 8);
  assert.equal(await io.exists(`items/${item.id}/audio/audio.mp3`), true);
});
