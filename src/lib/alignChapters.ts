const SKIP = /frontmatter|colophon|endnotes|imprint|uncopyright|copyright|half[- ]?title|titlepage|dedication|epigraph/i;

const ROMAN: Record<string, number> = {
  i: 1,
  ii: 2,
  iii: 3,
  iv: 4,
  v: 5,
  vi: 6,
  vii: 7,
  viii: 8,
  ix: 9,
  x: 10,
  xi: 11,
  xii: 12,
  xiii: 13,
  xiv: 14,
  xv: 15,
  xvi: 16,
  xvii: 17,
  xviii: 18,
  xix: 19,
  xx: 20,
};

function parseNum(token: string): number | null {
  if (/^\d+$/.test(token)) return Number(token);
  return ROMAN[token.toLowerCase()] ?? null;
}

function numberOf(title: string): number | null {
  const named = title.match(/(?:chapter|section|book|part)\s+([0-9]+|[ivxlcdm]+)/i);
  if (named) return parseNum(named[1]);
  const roman = title.trim().match(/^([ivxlcdm]{1,6})(?:\b|[:.\s])/i);
  if (roman) return parseNum(roman[1]);
  return null;
}

function tokens(title: string): Set<string> {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 3 && !['chapter', 'section', 'book', 'part', 'introduction'].includes(word));
  return new Set(words);
}

function scorePair(audioTitle: string, textTitle: string): number {
  let score = 0;
  const audioTokens = tokens(audioTitle);
  const textTokens = tokens(textTitle);
  for (const word of audioTokens) if (textTokens.has(word)) score += 2;
  const audioNumber = numberOf(audioTitle);
  const textNumber = numberOf(textTitle);
  if (audioNumber != null && audioNumber === textNumber) score += 3;
  if (/epilogue/i.test(audioTitle) && /epilogue/i.test(textTitle)) score += 4;
  return score;
}

function scoreRow(audioTitles: string[], textTitles: string[]): number {
  return audioTitles.reduce((sum, title, index) => sum + scorePair(title, textTitles[index] ?? ''), 0);
}

/** Map each audio track onto a text chapter, skipping imprint pages and preferring the chapter run that shares titles. */
export function alignAudioToText(audioTitles: string[], textTitles: string[]): number[] {
  const content = textTitles
    .map((title, index) => ({ title, index }))
    .filter((entry) => !SKIP.test(entry.title));
  if (!content.length) return audioTitles.map(() => 0);
  if (content.length >= audioTitles.length && audioTitles.length > 0) {
    const windows = [content.slice(0, audioTitles.length), content.slice(content.length - audioTitles.length)];
    let best = windows[0];
    let bestScore = -1;
    for (const window of windows) {
      const score = scoreRow(audioTitles, window.map((entry) => entry.title));
      if (score > bestScore) {
        bestScore = score;
        best = window;
      }
    }
    if (bestScore > 0) return best.map((entry) => entry.index);
  }
  if (content.length === audioTitles.length) return content.map((entry) => entry.index);
  return audioTitles.map((_, audioIndex) => {
    const slot = audioTitles.length <= 1 ? 0 : Math.round((audioIndex * (content.length - 1)) / (audioTitles.length - 1));
    return content[Math.min(content.length - 1, slot)].index;
  });
}
