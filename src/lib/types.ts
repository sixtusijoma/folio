export type ThemeName = 'light' | 'sepia' | 'dark';
export type FontChoice = 'serif' | 'sans';
export type ItemKind = 'book' | 'audiobook' | 'article' | 'audio';
export type SyncMode = 'vtt' | 'approximate' | 'none';
export type NarrationEngine = 'system' | 'kokoro' | 'gemini';
export type ListenMode = 'recording' | 'voice';

export type WordTime = {
  startMs: number;
  endMs: number;
};

export type Cue = {
  startMs: number;
  endMs: number;
  sentence: number;
  chapter: number;
  /** Audio chapter these times belong to. Omitted cues belong to audio chapter 0. */
  audio?: number;
  /** Whisper-aligned word starts. Absent cues fall back to character timing. */
  words?: WordTime[];
};

export type AudioChapter = {
  title: string;
  /** Filename inside the item's audio folder, once the bytes are local. */
  file?: string;
  url?: string;
  /** Text chapter, or null when this recording is preamble, outro, or not in the book. */
  textChapter?: number | null;
  /** LibriVox introduction before the chapter text, in milliseconds. */
  leadInMs?: number;
  /** Closing credit after the chapter text, in milliseconds. */
  tailMs?: number;
  /** First text sentence this file reads, when it does not start at the chapter's beginning. */
  sentenceStart?: number;
  /** Exclusive end sentence for an approximate file that covers part of a chapter. */
  sentenceEnd?: number;
  /** Start offset when several chapters share one file, as in an M4B. */
  startMs?: number;
};

export type TextChapter = {
  title: string;
  sentences: number;
};

export type Locator = {
  chapter: number;
  /** Older saves stored a horizontal page index. The reader no longer uses it. */
  page: number;
  sentence: number;
  /** Vertical position in the chapter, from 0 to 1. */
  scroll?: number;
};

export type LibraryItem = {
  id: string;
  kind: ItemKind;
  title: string;
  author: string;
  collection?: string;
  description?: string;
  sourceUrl?: string;
  sources?: string[];
  /** Human date line shown under the title. */
  dateLabel?: string;
  /** Short note shown under the title. */
  note?: string;
  /** True when the item must play its bundled file and must not fall through to TTS. */
  bundledAudio?: boolean;
  /** Play the bundled recording, or read the script in the Settings voice. */
  listen?: ListenMode;
  credit?: string;
  textSource?: string;
  textUrl?: string;
  audioSource?: string;
  audioUrl?: string;
  createdAt: number;
  lastOpenedAt: number | null;
  progress: number;
  locator: Locator | null;
  audioPositionMs: number;
  audioChapter: number;
  hasAudio: boolean;
  hasText: boolean;
  sync: SyncMode;
  linkedBookId?: string;
  coverPath?: string;
  chapters: TextChapter[];
  audioChapters: AudioChapter[];
  cues: Cue[];
};

export type LibraryData = {
  items: LibraryItem[];
};

export const SETTINGS_VERSION = 2;

export type Settings = {
  version: number;
  theme: ThemeName;
  font: FontChoice;
  fontSize: number;
  lineHeight: number;
  margin: number;
  engine: NarrationEngine;
  geminiVoice: string;
  geminiModel: string;
  kokoroVoice: string;
  systemVoice?: string;
  rate: number;
  skipBack: number;
  skipForward: number;
  /** Estimate a sentence when the recording has no transcript. */
  approximateSync: boolean;
  /** Scroll the spoken sentence into view while audio plays. */
  followPlayback: boolean;
};

export const defaultSettings: Settings = {
  version: SETTINGS_VERSION,
  theme: 'sepia',
  font: 'serif',
  fontSize: 20,
  lineHeight: 1.45,
  margin: 28,
  engine: 'system',
  geminiVoice: 'Kore',
  geminiModel: 'gemini-3.8-flash-lite-tts',
  kokoroVoice: 'af_heart',
  rate: 1,
  skipBack: 15,
  skipForward: 30,
  approximateSync: true,
  followPlayback: true,
};

export function mergeSettings(raw: (Partial<Settings> & { readAlongHighlight?: unknown }) | null | undefined): Settings {
  const source = { ...(raw ?? {}) };
  delete source.readAlongHighlight;
  return { ...defaultSettings, ...source, version: SETTINGS_VERSION };
}

export type SeedAudioChapter = {
  title: string;
  url: string;
  bytes?: number;
  file?: string;
  /** Text chapter index, or null when the recording is not in the book. */
  textChapter?: number | null;
  leadInMs?: number;
  tailMs?: number;
  sentenceStart?: number;
  sentenceEnd?: number;
  /** Bundled per-sentence cue file, produced by forced alignment. */
  cues?: string;
};

export type SeedAudioInfo = {
  slug: string;
  title: string;
  author: string;
  translator?: string | null;
  year?: string;
  interest?: string;
  swap?: boolean;
  textSource: string;
  textUrl: string;
  audioSource: string;
  archiveId: string;
  archiveUrl: string;
  license: string;
  chapters: SeedAudioChapter[];
};

export type FolioManifest = {
  folio: 1;
  kind?: 'audio' | 'audiobook' | 'book';
  title: string;
  author?: string;
  collection?: string;
  description?: string;
  sourceUrl?: string;
  sources?: string[];
  dateLabel?: string;
  note?: string;
  bundled?: boolean;
  publishedAt?: string;
  audio?: string;
  captions?: string;
  script?: string;
  words?: string;
  text?: string;
  voice?: string;
  rate?: string;
};

export type Io = {
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
  /** Read and replace one file in a single commit so a later write cannot land on a stale copy. */
  mutateText(path: string, update: (current: string | null) => string): Promise<void>;
  readBytes(path: string): Promise<Uint8Array | null>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
  uri(path: string): Promise<string | null>;
};
