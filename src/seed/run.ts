import { alignAudioToText } from '@/lib/alignChapters';
import { importEpubBytes, importFolioFiles, readLibrary, writeLibrary } from '@/lib/libraryStore';
import type { BookCueFile } from '@/lib/libraryStore';
import type { FolioManifest, Io } from '@/lib/types';

import { audioSeeds, bookSeeds } from '@/seed/assets';
import { loadAsset } from '@/seed/load';

const SEED_VERSION = 13;

async function importBookSeeds(io: Io, onStatus: (message: string) => void): Promise<void> {
  for (const book of bookSeeds) {
    onStatus(`Adding ${book.info.title}`);
    const epub = await loadAsset(book.epub);
    const audioFiles: Record<string, Uint8Array> = {};
    for (const [name, moduleId] of Object.entries(book.audio)) {
      audioFiles[name] = await loadAsset(moduleId);
    }
    const cueFiles = (book as { cues?: Record<string, BookCueFile> }).cues;
    await importEpubBytes(io, epub, { info: book.info, audioFiles, cueFiles });
  }
}

async function importAudioSeeds(io: Io, onStatus: (message: string) => void): Promise<void> {
  for (const bundle of audioSeeds) {
    const manifest = bundle.files['folio.json'] as FolioManifest;
    onStatus(`Adding ${manifest.title}`);
    const files: Record<string, Uint8Array> = {
      'folio.json': new TextEncoder().encode(JSON.stringify(bundle.files['folio.json'])),
    };
    for (const [name, value] of Object.entries(bundle.files)) {
      if (name === 'folio.json') continue;
      if (name.endsWith('.json')) {
        files[name] = new TextEncoder().encode(JSON.stringify(value));
        continue;
      }
      files[name] = await loadAsset(value as number);
    }
    await importFolioFiles(io, files);
  }
}

export async function seedIfNeeded(io: Io, onStatus: (message: string) => void): Promise<void> {
  const existing = await io.readText('seeded.json');
  const version = existing ? ((JSON.parse(existing) as { version?: number }).version ?? 1) : 0;
  if (version >= SEED_VERSION) return;
  if (version > 0) {
    if (version < 2) {
      onStatus('Lining audiobook chapters up with the text');
      const data = await readLibrary(io);
      for (const item of data.items) {
        if (!item.hasText || !item.audioChapters.length || item.sync === 'vtt') continue;
        const indexes = alignAudioToText(
          item.audioChapters.map((chapter) => chapter.title),
          item.chapters.map((chapter) => chapter.title),
        );
        item.audioChapters = item.audioChapters.map((chapter, index) => ({ ...chapter, textChapter: indexes[index] }));
        if ((item.locator?.chapter ?? 0) === 0 && indexes[0]) item.locator = { chapter: indexes[0], page: 0, sentence: 0 };
      }
      await writeLibrary(io, data);
    }
    onStatus('Refreshing the seeded shelf');
    const library = await readLibrary(io);
    library.items = library.items.filter((item) => {
      if (item.kind === 'book' && item.audioSource === 'LibriVox') {
        return false;
      }
      if (item.author === 'Folio demo') {
        return false;
      }
      return true;
    });
    await writeLibrary(io, library);
    await importBookSeeds(io, onStatus);
    await importAudioSeeds(io, onStatus);
    await io.writeText('seeded.json', JSON.stringify({ version: SEED_VERSION }));
    return;
  }
  await importBookSeeds(io, onStatus);
  await importAudioSeeds(io, onStatus);
  await io.writeText('seeded.json', JSON.stringify({ version: SEED_VERSION }));
}
