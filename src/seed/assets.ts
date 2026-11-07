import type { BookCueFile } from '@/lib/libraryStore';
import type { FolioManifest, SeedAudioInfo } from '@/lib/types';

/* Metro asset ids for the starter library: two public-domain books and one short demo. */

export const bookSeeds = [
  {
    slug: 'art-of-war',
    epub: require('../../assets/seed/books/art-of-war/book.epub') as number,
    info: require('../../assets/seed/books/art-of-war/audio.json') as SeedAudioInfo,
    audio: {
      'audio-00.mp3': require('../../assets/seed/books/art-of-war/audio-00.mp3') as number,
    } as Record<string, number>,
    cues: {
      'audio-00.cues.json': require('../../assets/seed/books/art-of-war/audio-00.cues.json') as BookCueFile,
    } as Record<string, BookCueFile>,
  },
  {
    slug: 'time-machine',
    epub: require('../../assets/seed/books/time-machine/book.epub') as number,
    info: require('../../assets/seed/books/time-machine/audio.json') as SeedAudioInfo,
    audio: {
      'audio-00.mp3': require('../../assets/seed/books/time-machine/audio-00.mp3') as number,
    } as Record<string, number>,
    cues: {
      'audio-00.cues.json': require('../../assets/seed/books/time-machine/audio-00.cues.json') as BookCueFile,
    } as Record<string, BookCueFile>,
  },
] as const;

export const audioSeeds = [
  {
    slug: 'lamp',
    files: {
      'audio.mp3': require('../../assets/seed/demo/lamp/audio.mp3') as number,
      'captions.vtt': require('../../assets/seed/demo/lamp/captions.vtt') as number,
      'folio.json': require('../../assets/seed/demo/lamp/folio.json') as FolioManifest,
      'script.txt': require('../../assets/seed/demo/lamp/script.txt') as number,
    },
  },
] as const;
