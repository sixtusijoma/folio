export type VttCue = {
  startMs: number;
  endMs: number;
  text: string;
};

function stampToMs(stamp: string): number {
  const match = stamp.trim().match(/(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{1,3})/);
  if (!match) return 0;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const fraction = match[4].padEnd(3, '0');
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + Number(fraction);
}

export function parseVtt(source: string): VttCue[] {
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  const cues: VttCue[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line || line === 'WEBVTT' || line.startsWith('NOTE') || line.startsWith('STYLE') || line.startsWith('REGION')) {
      index += 1;
      continue;
    }
    let timing = line;
    if (!line.includes('-->') && index + 1 < lines.length && lines[index + 1].includes('-->')) {
      index += 1;
      timing = lines[index].trim();
    }
    if (!timing.includes('-->')) {
      index += 1;
      continue;
    }
    const [start, endPart] = timing.split('-->');
    // The end stamp is preceded by a space, so an untrimmed split yields ''.
    const end = (endPart ?? '').trim().split(/\s+/)[0] ?? '';
    index += 1;
    const textLines: string[] = [];
    while (index < lines.length && lines[index].trim() !== '') {
      textLines.push(lines[index].trim());
      index += 1;
    }
    const text = textLines.join(' ').replace(/<[^>]+>/g, '').trim();
    if (text) {
      cues.push({ startMs: stampToMs(start), endMs: stampToMs(end), text });
    }
  }
  return cues;
}

/** Edge-tts sometimes emits one cue per word. Fold those into sentences. */
export function cuesToSentences(cues: VttCue[]): VttCue[] {
  if (!cues.length) return [];
  const average = cues.reduce((sum, cue) => sum + cue.text.length, 0) / cues.length;
  if (average > 28) return cues;
  const grouped: VttCue[] = [];
  let current: VttCue | null = null;
  for (const cue of cues) {
    if (!current) {
      current = { startMs: cue.startMs, endMs: cue.endMs, text: cue.text };
    } else {
      current = { startMs: current.startMs, endMs: cue.endMs, text: `${current.text} ${cue.text}`.trim() };
    }
    if (/[.!?]["']?$/.test(cue.text)) {
      grouped.push(current);
      current = null;
    }
  }
  if (current) grouped.push(current);
  return grouped;
}
