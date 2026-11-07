export function normalizeClock(current: number, duration: number): { positionMs: number; durationMs: number } {
  const position = Number.isFinite(current) && current > 0 ? current : 0;
  const span = Number.isFinite(duration) && duration > 0 ? duration : 0;
  // Mixed clocks show up as a millisecond position against a duration still in seconds.
  // The position is then far larger than the duration, not merely a little past the end.
  if (span > 0 && position > span * 50 && position / 1000 <= span + 0.05) {
    return { positionMs: position, durationMs: span * 1000 };
  }
  if (span >= 100_000 && position <= span) {
    return { positionMs: position, durationMs: span };
  }
  return { positionMs: position * 1000, durationMs: span * 1000 };
}

export function wordsOf(sentence: string): string[] {
  return sentence.split(/\s+/).filter(Boolean);
}

export function wordWeights(words: string[]): number[] {
  return words.map((word) => Math.max(1, [...word].length));
}

export function wordStartMs(weights: number[], index: number, durationMs: number): number {
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  const before = weights.slice(0, Math.max(0, index)).reduce((sum, weight) => sum + weight, 0);
  return (before / total) * Math.max(0, durationMs);
}

