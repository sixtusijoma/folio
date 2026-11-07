const ABBREVIATION = /(?:Mr|Mrs|Ms|Dr|St|Jr|Sr|Prof|Rev|Gen|Col|Lt|Sgt|No|vs|etc|Fig|Vol|pp|e\.g|i\.e)\.$/i;

/** Split prose into sentences, keeping Mr. / Dr. / e.g. intact. */
export function splitSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const out: string[] = [];
  let buffer = '';
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    buffer += ch;
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;
    let j = i + 1;
    while (j < normalized.length && /["')\]]/.test(normalized[j])) {
      buffer += normalized[j];
      j += 1;
    }
    if (ch === '.' && ABBREVIATION.test(buffer.trim())) {
      i = j - 1;
      continue;
    }
    if (j >= normalized.length || /\s/.test(normalized[j])) {
      const sentence = buffer.trim();
      if (sentence) out.push(sentence);
      buffer = '';
      i = j - 1;
    }
  }
  const tail = buffer.trim();
  if (tail) out.push(tail);
  return out;
}

export function hashText(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/** Group sentences into chunks that stay under maxChars, never splitting a sentence. */
export function chunkSentences(sentences: string[], maxChars: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const sentence of sentences) {
    if (current.length && size + sentence.length + 1 > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(sentence);
    size += sentence.length + 1;
  }
  if (current.length) chunks.push(current);
  return chunks;
}
