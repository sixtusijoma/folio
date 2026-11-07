import assert from 'node:assert/strict';
import test from 'node:test';

import { DOWNLOAD_RETRY_DELAYS_MS, ensureAudioLocal, writeLibrary } from '../src/lib/libraryStore';
import { playbackNotice } from '../src/lib/playback';
import type { LibraryItem } from '../src/lib/types';
import { memoryIo } from '../src/storage/memory';

const FILE = 'items/book/audio/ch-0.mp3';

function chapterItem(): LibraryItem {
  return {
    id: 'book',
    kind: 'book',
    title: 'The Art of War',
    author: 'Sun Tzu',
    createdAt: 1,
    lastOpenedAt: null,
    progress: 0,
    locator: null,
    audioPositionMs: 0,
    audioChapter: 0,
    hasAudio: true,
    hasText: true,
    sync: 'approximate',
    chapters: [{ title: 'II: Waging War', sentences: 10 }],
    audioChapters: [{ title: '02 - WAGING WAR', url: 'https://archive.org/download/example/chapter.mp3' }],
    cues: [],
  };
}

function useFetch(handler: (call: number, init?: RequestInit) => Promise<Response> | Response) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    calls += 1;
    return handler(calls, init);
  }) as typeof fetch;
  return {
    calls: () => calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test('download retries wait about 1s and then 3s', () => {
  assert.deepEqual(DOWNLOAD_RETRY_DELAYS_MS, [1000, 3000]);
  assert.match(playbackNotice(new TypeError('net::ERR_FAILED')), /could not be downloaded/);
});

test('a chapter that fails once then succeeds is saved without throwing', async (t) => {
  const io = memoryIo();
  const item = chapterItem();
  await writeLibrary(io, { items: [item] });
  const slept: number[] = [];
  const fetchMock = useFetch((call) => (call === 1 ? new Response('no', { status: 503 }) : new Response(Uint8Array.from([7, 7]))));
  t.after(fetchMock.restore);

  const saved = await ensureAudioLocal(io, item, 0, {
    delays: DOWNLOAD_RETRY_DELAYS_MS,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });

  assert.deepEqual(slept, [1000]);
  assert.equal(fetchMock.calls(), 2);
  assert.equal(saved.audioChapters[0].file, 'ch-0.mp3');
  assert.deepEqual(Array.from((await io.readBytes(FILE)) ?? []), [7, 7]);

  const again = await ensureAudioLocal(io, saved, 0, {
    sleep: async () => {
      throw new Error('should not retry a file that is already local');
    },
  });
  assert.equal(again.audioChapters[0].file, 'ch-0.mp3');
  assert.equal(fetchMock.calls(), 2);
});

test('a chapter that fails every time throws once and keeps no partial file', async (t) => {
  const io = memoryIo();
  const slept: number[] = [];
  const fetchMock = useFetch(() => {
    throw new TypeError('Failed to fetch');
  });
  t.after(fetchMock.restore);

  await assert.rejects(
    ensureAudioLocal(io, chapterItem(), 0, {
      delays: DOWNLOAD_RETRY_DELAYS_MS,
      sleep: async (ms) => {
        slept.push(ms);
        assert.equal(await io.exists(FILE), false);
      },
    }),
    /could not be downloaded/,
  );
  assert.deepEqual(slept, [1000, 3000]);
  assert.equal(fetchMock.calls(), 3);
  assert.equal(await io.exists(FILE), false);
});

test('a 404 is not retried', async (t) => {
  const io = memoryIo();
  const slept: number[] = [];
  const fetchMock = useFetch(() => new Response('missing', { status: 404 }));
  t.after(fetchMock.restore);

  await assert.rejects(
    ensureAudioLocal(io, chapterItem(), 0, {
      delays: DOWNLOAD_RETRY_DELAYS_MS,
      sleep: async (ms) => {
        slept.push(ms);
      },
    }),
    /Could not download this chapter \(404\)/,
  );
  assert.deepEqual(slept, []);
  assert.equal(fetchMock.calls(), 1);
  assert.equal(await io.exists(FILE), false);
});

test('a 429 is retried and a 400 is not', async () => {
  const io = memoryIo();
  const fetchMock = useFetch((call) => (call === 1 ? new Response('slow', { status: 429 }) : new Response(Uint8Array.from([1]))));
  try {
    const saved = await ensureAudioLocal(io, chapterItem(), 0, { delays: [0, 0], sleep: async () => undefined });
    assert.equal(saved.audioChapters[0].file, 'ch-0.mp3');
    assert.equal(fetchMock.calls(), 2);
  } finally {
    fetchMock.restore();
  }

  const missing = memoryIo();
  const denied = useFetch(() => new Response('no', { status: 400 }));
  try {
    await assert.rejects(ensureAudioLocal(missing, chapterItem(), 0, { delays: [0, 0], sleep: async () => undefined }), /400/);
    assert.equal(denied.calls(), 1);
  } finally {
    denied.restore();
  }
});

test('a partial file is removed before the next attempt', async (t) => {
  const io = memoryIo();
  const writing = io.writeBytes.bind(io);
  io.writeBytes = async (path, bytes) => {
    await writing(path, bytes);
    if (bytes[0] === 1) throw new TypeError('net::ERR_FAILED');
  };
  const duringBackoff: boolean[] = [];
  const fetchMock = useFetch((call) => new Response(Uint8Array.from([call === 1 ? 1 : 2])));
  t.after(fetchMock.restore);

  const saved = await ensureAudioLocal(io, chapterItem(), 0, {
    delays: DOWNLOAD_RETRY_DELAYS_MS,
    sleep: async () => {
      duringBackoff.push(await io.exists(FILE));
    },
  });

  assert.deepEqual(duringBackoff, [false]);
  assert.equal(fetchMock.calls(), 2);
  assert.equal(saved.audioChapters[0].file, 'ch-0.mp3');
  assert.deepEqual(Array.from((await io.readBytes(FILE)) ?? []), [2]);
});

test('cancelling during the backoff does not try again', async (t) => {
  const io = memoryIo();
  const fetchMock = useFetch(() => {
    throw new TypeError('Failed to fetch');
  });
  t.after(fetchMock.restore);
  const controller = new AbortController();
  const pending = ensureAudioLocal(io, chapterItem(), 0, { signal: controller.signal, delays: [400, 400] });
  setTimeout(() => controller.abort(), 30);

  await assert.rejects(pending, (error: unknown) => {
    assert.equal(error instanceof Error ? error.name : '', 'AbortError');
    return true;
  });
  assert.equal(fetchMock.calls(), 1);
  assert.equal(await io.exists(FILE), false);
});
