import { alignAudioToText } from '@/lib/alignChapters';
import { alignCues } from '@/lib/cues';
import { parseEpub } from '@/lib/epub';
import { scriptSentences, scriptToHtml } from '@/lib/html';
import { basename, lookupFile, parseFolioManifest } from '@/lib/manifest';
import { m4bChapters } from '@/lib/m4b';
import { playbackNotice } from '@/lib/playback';
import type { AudioChapter, Cue, Io, LibraryData, LibraryItem, SeedAudioInfo, TextChapter } from '@/lib/types';
import { cuesToSentences, parseVtt } from '@/lib/vtt';

const INDEX = 'library.json';

export function createId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function parseLibrary(raw: string | null): LibraryData {
  if (!raw) return { items: [] };
  const parsed = JSON.parse(raw) as LibraryData;
  return { items: parsed.items ?? [] };
}

export async function readLibrary(io: Io): Promise<LibraryData> {
  return parseLibrary(await io.readText(INDEX));
}

async function mutateLibrary(io: Io, update: (data: LibraryData) => void): Promise<void> {
  await io.mutateText(INDEX, (raw) => {
    const data = parseLibrary(raw);
    update(data);
    return JSON.stringify(data);
  });
}

let libraryWriteTail: Promise<void> = Promise.resolve();

/** Run a library read-modify-write only after every earlier one has finished. */
function enqueueLibraryWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = libraryWriteTail.then(task, task);
  libraryWriteTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function writeLibraryNow(io: Io, data: LibraryData): Promise<void> {
  await mutateLibrary(io, (current) => {
    current.items = data.items;
  });
}

/** Resolves when every library save already queued has committed. */
export function libraryWritesSettled(): Promise<void> {
  return libraryWriteTail;
}

export function writeLibrary(io: Io, data: LibraryData): Promise<void> {
  return enqueueLibraryWrite(() => writeLibraryNow(io, data));
}

function decoder() {
  return new TextDecoder();
}

function remember(io: Io, item: LibraryItem): Promise<LibraryItem> {
  return enqueueLibraryWrite(async () => {
    await mutateLibrary(io, (data) => {
      data.items = [item, ...data.items.filter((existing) => existing.id !== item.id)];
    });
    return item;
  });
}

export function updateItem(io: Io, id: string, patch: Partial<LibraryItem>): Promise<LibraryItem | null> {
  return enqueueLibraryWrite(async () => {
    let updated: LibraryItem | null = null;
    await mutateLibrary(io, (data) => {
      const index = data.items.findIndex((item) => item.id === id);
      if (index < 0) return;
      data.items[index] = { ...data.items[index], ...patch };
      updated = data.items[index];
    });
    return updated;
  });
}

export function deleteItem(io: Io, id: string): Promise<void> {
  return enqueueLibraryWrite(async () => {
    await mutateLibrary(io, (data) => {
      data.items = data.items.filter((item) => item.id !== id);
    });
  });
}

function textChapterFor(audioTitles: string[], textTitles: string[]): number[] {
  return alignAudioToText(audioTitles, textTitles);
}

async function writeChapters(io: Io, id: string, chapters: { title: string; html: string; sentences: number }[]) {
  for (let index = 0; index < chapters.length; index += 1) {
    await io.writeText(`items/${id}/chapters/${index}.html`, chapters[index].html);
  }
}

export async function readChapter(io: Io, id: string, index: number): Promise<string> {
  return (await io.readText(`items/${id}/chapters/${index}.html`)) ?? '<p>This chapter is empty.</p>';
}

export async function importEpubBytes(
  io: Io,
  bytes: Uint8Array,
  extra?: {
    info?: SeedAudioInfo;
    audioFiles?: Record<string, Uint8Array>;
    cueFiles?: Record<string, BookCueFile>;
  },
): Promise<LibraryItem> {
  const book = await parseEpub(bytes);
  const id = createId();
  await writeChapters(io, id, book.chapters);
  let coverPath: string | undefined;
  if (book.cover) {
    coverPath = `items/${id}/cover`;
    await io.writeBytes(coverPath, book.cover.bytes);
  }
  const audioChapters: AudioChapter[] = [];
  const cues: Cue[] = [];
  const textIndexes = extra?.info
    ? textChapterFor(
        extra.info.chapters.map((chapter) => chapter.title),
        book.chapters.map((chapter) => chapter.title),
      )
    : [];
  if (extra?.info) {
    for (let index = 0; index < extra.info.chapters.length; index += 1) {
      const chapter = extra.info.chapters[index];
      const mapped = chapter.textChapter !== undefined ? chapter.textChapter : (textIndexes[index] ?? 0);
      const entry: AudioChapter = {
        title: chapter.title,
        url: chapter.url,
        textChapter: mapped,
        ...(chapter.leadInMs ? { leadInMs: chapter.leadInMs } : {}),
        ...(chapter.tailMs ? { tailMs: chapter.tailMs } : {}),
        ...(chapter.sentenceStart != null ? { sentenceStart: chapter.sentenceStart } : {}),
        ...(chapter.sentenceEnd != null ? { sentenceEnd: chapter.sentenceEnd } : {}),
      };
      if (chapter.file && extra.audioFiles?.[chapter.file]) {
        const filename = `ch-${index}.mp3`;
        await io.writeBytes(`items/${id}/audio/${filename}`, extra.audioFiles[chapter.file]);
        entry.file = filename;
      }
      const cueFile = chapter.cues ? extra.cueFiles?.[chapter.cues] : undefined;
      if (cueFile && mapped != null) {
        for (const row of cueFile.sentences) {
          cues.push({
            startMs: row.startMs,
            endMs: Math.max(row.endMs, row.startMs + 1),
            sentence: row.sentence,
            chapter: mapped,
            audio: index,
          });
        }
      }
      audioChapters.push(entry);
    }
  }
  const item: LibraryItem = {
    id,
    kind: 'book',
    title: extra?.info?.title || book.title,
    author: extra?.info?.author || book.author,
    description: extra?.info?.interest,
    credit: extra?.info?.license,
    textSource: extra?.info?.textSource,
    textUrl: extra?.info?.textUrl,
    audioSource: extra?.info ? 'LibriVox' : undefined,
    audioUrl: extra?.info?.archiveUrl,
    createdAt: Date.now(),
    lastOpenedAt: null,
    progress: 0,
    locator: { chapter: audioChapters.find((chapter) => chapter.textChapter != null)?.textChapter ?? textIndexes[0] ?? 0, page: 0, sentence: 0 },
    audioPositionMs: 0,
    audioChapter: 0,
    hasAudio: audioChapters.length > 0,
    hasText: true,
    sync: cues.length ? 'vtt' : audioChapters.length ? 'approximate' : 'none',
    coverPath,
    chapters: book.chapters.map((chapter) => ({ title: chapter.title, sentences: chapter.sentences })),
    audioChapters,
    cues,
  };
  return remember(io, item);
}

export type BookCueFile = {
  sentences: { sentence: number; startMs: number; endMs: number; words: [number, number][] }[];
};

export async function importFolioFiles(io: Io, files: Record<string, Uint8Array>): Promise<LibraryItem> {
  const manifestKey = Object.keys(files).find((name) => basename(name) === 'folio.json');
  if (!manifestKey) throw new Error('No folio.json in this bundle.');
  const manifest = parseFolioManifest(decoder().decode(files[manifestKey]));
  const audio = lookupFile(files, manifest.audio);
  const captions = lookupFile(files, manifest.captions);
  const scriptBytes = lookupFile(files, manifest.script);
  const script = scriptBytes ? decoder().decode(scriptBytes) : captions ? cuesToSentences(parseVtt(decoder().decode(captions))).map((cue) => cue.text).join(' ') : '';
  if (!script.trim() && !audio) throw new Error('The bundle needs an audio file or a script.');
  const sentences = script.trim() ? scriptSentences(script) : [];
  const rendered = sentences.length ? scriptToHtml(script) : { html: '<p></p>', count: 0 };
  const vttCues = captions ? cuesToSentences(parseVtt(decoder().decode(captions))) : [];
  const cues = vttCues.length ? alignCues(vttCues, sentences.length ? sentences : Math.max(1, rendered.count), 0) : [];
  const id = createId();
  if (rendered.count) await io.writeText(`items/${id}/chapters/0.html`, rendered.html);
  const audioChapters: AudioChapter[] = [];
  if (audio) {
    const extension = (manifest.audio?.split('.').pop() || 'mp3').toLowerCase();
    const filename = `audio.${extension}`;
    await io.writeBytes(`items/${id}/audio/${filename}`, audio);
    audioChapters.push({ title: manifest.title, file: filename, textChapter: 0 });
  }
  const chapters: TextChapter[] = rendered.count ? [{ title: manifest.title, sentences: rendered.count }] : [];
  const item: LibraryItem = {
    id,
    kind: manifest.kind === 'audiobook' ? 'audiobook' : 'audio',
    title: manifest.title,
    author: manifest.author || 'Imported',
    collection: manifest.collection,
    description: manifest.description,
    sourceUrl: manifest.sourceUrl,
    sources: manifest.sources,
    dateLabel: manifest.dateLabel,
    note: manifest.note,
    bundledAudio: Boolean(audio) && (manifest.bundled === true || !manifest.collection),
    createdAt: manifest.publishedAt ? Date.parse(manifest.publishedAt) || Date.now() : Date.now(),
    lastOpenedAt: null,
    progress: 0,
    locator: { chapter: 0, page: 0, sentence: 0 },
    audioPositionMs: 0,
    audioChapter: 0,
    hasAudio: audioChapters.length > 0,
    hasText: chapters.length > 0,
    sync: cues.length ? 'vtt' : audioChapters.length && chapters.length ? 'approximate' : 'none',
    chapters,
    audioChapters,
    cues,
  };
  return remember(io, item);
}

export async function importAudioBytes(
  io: Io,
  filename: string,
  bytes: Uint8Array,
  extras?: { captions?: Uint8Array; script?: Uint8Array },
): Promise<LibraryItem> {
  if (extras?.captions || extras?.script) {
    const files: Record<string, Uint8Array> = { [filename]: bytes };
    if (extras.captions) files['captions.vtt'] = extras.captions;
    if (extras.script) files['script.txt'] = extras.script;
    files['folio.json'] = new TextEncoder().encode(
      JSON.stringify({
        folio: 1,
        kind: 'audio',
        title: filename.replace(/\.[^.]+$/, ''),
        author: 'Imported',
        audio: filename,
        captions: extras.captions ? 'captions.vtt' : undefined,
        script: extras.script ? 'script.txt' : undefined,
      }),
    );
    return importFolioFiles(io, files);
  }
  const marks = /\.(m4b|m4a)$/i.test(filename) ? m4bChapters(bytes) : [];
  const id = createId();
  const extension = (filename.split('.').pop() || 'mp3').toLowerCase();
  const stored = `audio.${extension}`;
  await io.writeBytes(`items/${id}/audio/${stored}`, bytes);
  const audioChapters: AudioChapter[] =
    marks.length > 0
      ? marks.map((mark) => ({ title: mark.title, file: stored, textChapter: 0, startMs: mark.startMs }))
      : [{ title: filename.replace(/\.[^.]+$/, ''), file: stored }];
  const item: LibraryItem = {
    id,
    kind: 'audiobook',
    title: filename.replace(/\.[^.]+$/, ''),
    author: 'Imported audio',
    createdAt: Date.now(),
    lastOpenedAt: null,
    progress: 0,
    locator: null,
    audioPositionMs: marks[0]?.startMs ?? 0,
    audioChapter: 0,
    hasAudio: true,
    hasText: false,
    sync: 'none',
    chapters: [],
    audioChapters,
    cues: marks.length
      ? marks.map((mark, index) => ({
          startMs: mark.startMs,
          endMs: marks[index + 1]?.startMs ?? mark.startMs + 1,
          sentence: 0,
          chapter: 0,
        }))
      : [],
  };
  return remember(io, item);
}

export async function importArticleHtml(
  io: Io,
  article: { title: string; author: string; html: string; sentences: number; sourceUrl?: string },
): Promise<LibraryItem> {
  const id = createId();
  await io.writeText(`items/${id}/chapters/0.html`, article.html);
  const item: LibraryItem = {
    id,
    kind: 'article',
    title: article.title,
    author: article.author,
    sourceUrl: article.sourceUrl,
    createdAt: Date.now(),
    lastOpenedAt: null,
    progress: 0,
    locator: { chapter: 0, page: 0, sentence: 0 },
    audioPositionMs: 0,
    audioChapter: 0,
    hasAudio: false,
    hasText: true,
    sync: 'none',
    chapters: [{ title: article.title, sentences: article.sentences }],
    audioChapters: [],
    cues: [],
  };
  return remember(io, item);
}

export async function attachAudio(io: Io, bookId: string, audioId: string): Promise<LibraryItem | null> {
  const data = await readLibrary(io);
  const book = data.items.find((item) => item.id === bookId);
  const audio = data.items.find((item) => item.id === audioId);
  if (!book?.hasText || !audio?.audioChapters.length) return null;
  const audioChapters: AudioChapter[] = [];
  for (let index = 0; index < audio.audioChapters.length; index += 1) {
    const chapter = audio.audioChapters[index];
    const next: AudioChapter = {
      title: chapter.title,
      url: chapter.url,
      startMs: chapter.startMs,
      textChapter: alignAudioToText(
        audio.audioChapters.map((entry) => entry.title),
        book.chapters.map((entry) => entry.title),
      )[index],
    };
    if (chapter.file) {
      const bytes = await io.readBytes(`items/${audio.id}/audio/${chapter.file}`);
      if (bytes) {
        await io.writeBytes(`items/${book.id}/audio/${chapter.file}`, bytes);
        next.file = chapter.file;
      }
    }
    audioChapters.push(next);
  }
  return updateItem(io, bookId, {
    hasAudio: audioChapters.length > 0,
    audioChapters,
    cues: [],
    sync: audioChapters.length > 0 ? 'approximate' : 'none',
    linkedBookId: audioId,
    audioSource: book.audioSource || audio.audioSource || audio.author,
  });
}

/** Backoff before each extra attempt. One try, then these two, for three attempts in all. */
export const DOWNLOAD_RETRY_DELAYS_MS = [1000, 3000] as const;

export type EnsureAudioOptions = {
  signal?: AbortSignal;
  /** Delay before each extra attempt. Defaults to 1s then 3s. */
  delays?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
};

export function isDownloadCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function cancelledDownload(): Error {
  const error = new Error('The download was cancelled.');
  error.name = 'AbortError';
  return error;
}

function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancelledDownload());
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelledDownload());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const TRANSIENT_NETWORK = /failed to fetch|network request failed|load failed|networkerror|err_failed/i;

function isTransientNetwork(error: unknown): boolean {
  if (isDownloadCancelled(error)) return false;
  const message = error instanceof Error ? error.message : '';
  return TRANSIENT_NETWORK.test(message);
}

function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

export async function ensureAudioLocal(
  io: Io,
  item: LibraryItem,
  chapterIndex: number,
  options?: EnsureAudioOptions,
): Promise<LibraryItem> {
  const chapter = item.audioChapters[chapterIndex];
  if (!chapter) throw new Error('That chapter is missing.');
  if (chapter.file && (await io.exists(`items/${item.id}/audio/${chapter.file}`))) return item;
  if (!chapter.url) throw new Error('This chapter is not on the device yet, and there is no download link.');

  const filename = `ch-${chapterIndex}.mp3`;
  const path = `items/${item.id}/audio/${filename}`;
  const delays = options?.delays ?? DOWNLOAD_RETRY_DELAYS_MS;
  const attempts = delays.length + 1;
  const signal = options?.signal;
  const pause = async (ms: number) => {
    if (signal?.aborted) throw cancelledDownload();
    if (options?.sleep) {
      await options.sleep(ms);
      if (signal?.aborted) throw cancelledDownload();
      return;
    }
    await waitForRetry(ms, signal);
  };
  const discard = () => io.remove(path).catch(() => undefined);

  let failure: Error | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal?.aborted) throw cancelledDownload();
    await discard();
    try {
      const response = await fetch(chapter.url, { signal });
      if (!response.ok) {
        failure = new Error(`Could not download this chapter (${response.status}).`);
        if (!isTransientStatus(response.status) || attempt === attempts - 1) throw failure;
      } else {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (signal?.aborted) throw cancelledDownload();
        await io.writeBytes(path, bytes);
        if (signal?.aborted) throw cancelledDownload();
        const audioChapters = item.audioChapters.map((entry, index) => (index === chapterIndex ? { ...entry, file: filename } : entry));
        return (await updateItem(io, item.id, { audioChapters })) ?? { ...item, audioChapters };
      }
    } catch (error) {
      await discard();
      if (isDownloadCancelled(error) || signal?.aborted) throw isDownloadCancelled(error) ? error : cancelledDownload();
      if (isTransientNetwork(error)) {
        failure = new Error(playbackNotice(error));
        if (attempt === attempts - 1) throw failure;
      } else if (failure && error === failure) {
        throw failure;
      } else {
        throw error instanceof Error ? error : new Error(playbackNotice(error));
      }
    }
    await pause(delays[attempt] ?? 0);
  }
  throw failure ?? new Error('This chapter could not be downloaded. Check the connection and try again.');
}

export function emptyCues(): Cue[] {
  return [];
}
