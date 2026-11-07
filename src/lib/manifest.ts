import type { FolioManifest } from '@/lib/types';

export function parseFolioManifest(raw: string): FolioManifest {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('The manifest is not valid JSON.');
  }
  if (!data || typeof data !== 'object') throw new Error('The manifest is empty.');
  const record = data as Record<string, unknown>;
  if (record.folio !== 1) throw new Error('This file is not a Folio audio manifest (folio: 1).');
  if (typeof record.title !== 'string' || !record.title.trim()) throw new Error('The manifest needs a title.');
  const kind = record.kind;
  if (kind != null && kind !== 'audio' && kind !== 'audiobook' && kind !== 'book') {
    throw new Error('Manifest kind must be audio, audiobook, or book.');
  }
  return {
    folio: 1,
    kind: kind as FolioManifest['kind'],
    title: record.title.trim(),
    author: typeof record.author === 'string' ? record.author : undefined,
    collection: typeof record.collection === 'string' ? record.collection : undefined,
    description: typeof record.description === 'string' ? record.description : undefined,
    sourceUrl: typeof record.sourceUrl === 'string' ? record.sourceUrl : undefined,
    sources: Array.isArray(record.sources) ? record.sources.filter((entry): entry is string => typeof entry === 'string') : undefined,
    dateLabel: typeof record.dateLabel === 'string' ? record.dateLabel : undefined,
    note: typeof record.note === 'string' ? record.note : undefined,
    bundled: record.bundled === true ? true : undefined,
    publishedAt: typeof record.publishedAt === 'string' ? record.publishedAt : undefined,
    audio: typeof record.audio === 'string' ? record.audio : undefined,
    captions: typeof record.captions === 'string' ? record.captions : undefined,
    script: typeof record.script === 'string' ? record.script : undefined,
    words: typeof record.words === 'string' ? record.words : undefined,
    text: typeof record.text === 'string' ? record.text : undefined,
    voice: typeof record.voice === 'string' ? record.voice : undefined,
    rate: typeof record.rate === 'string' ? record.rate : undefined,
  };
}

export function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

export function lookupFile(files: Record<string, Uint8Array>, name: string | undefined): Uint8Array | null {
  if (!name) return null;
  if (files[name]) return files[name];
  const base = basename(name);
  if (files[base]) return files[base];
  const found = Object.keys(files).find((key) => basename(key) === base);
  return found ? files[found] : null;
}
