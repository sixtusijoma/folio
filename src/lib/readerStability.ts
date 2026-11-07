export type ChapterLoad = { itemId: string; chapter: number };

/** A playback tick that keeps the same item and chapter must not reload the text. */
export function shouldReloadChapter(loaded: ChapterLoad | null, next: ChapterLoad): boolean {
  if (!loaded) return true;
  return loaded.itemId !== next.itemId || loaded.chapter !== next.chapter;
}

export function playbackReloads(ticks: ChapterLoad[]): number {
  let loaded: ChapterLoad | null = null;
  let reloads = 0;
  for (const tick of ticks) {
    if (shouldReloadChapter(loaded, tick)) {
      reloads += 1;
      loaded = { itemId: tick.itemId, chapter: tick.chapter };
    }
  }
  return reloads;
}
