import type { Settings } from '@/lib/types';

export type SystemVoice = { identifier: string; name: string; language: string; quality?: string };

export type VoiceChoice = { identifier: string; label: string };

type NamedVoice = { id: string; label: string };

function shortName(voices: NamedVoice[], id: string): string {
  const found = voices.find((voice) => voice.id === id);
  return found ? found.label.split(' · ')[0] : id;
}

/** The voice narration will use, short enough for a toggle: "System", "Kokoro · Emma", "Gemini · Kore". */
export function narrationLabel(
  settings: Pick<Settings, 'engine' | 'kokoroVoice' | 'geminiVoice'>,
  kokoroVoices: NamedVoice[],
  geminiVoices: NamedVoice[],
): string {
  if (settings.engine === 'kokoro') {
    return `Kokoro · ${shortName(kokoroVoices, settings.kokoroVoice)}`;
  }
  if (settings.engine === 'gemini') {
    return `Gemini · ${shortName(geminiVoices, settings.geminiVoice)}`;
  }
  return 'System';
}

// iOS lists its novelty voices (Bahh, Bells, Zarvox…) and the Eloquence set (Eddy, Flo, Grandma…)
// once per English locale. They crowd out the voices that read well.
function isNovelty(identifier: string): boolean {
  return identifier.startsWith('com.apple.speech.synthesis.voice.') || identifier.includes('.eloquence.');
}

function tier(voice: SystemVoice): number {
  // Android network voices need a connection mid-sentence, so they rank after every local voice.
  const offline = voice.identifier.endsWith('-network') ? 3 : 0;
  if (voice.identifier.includes('.premium.')) {
    return offline;
  }
  if (voice.identifier.includes('.enhanced.') || voice.quality === 'Enhanced') {
    return offline + 1;
  }
  return offline + 2;
}

function localeRank(language: string): number {
  const order = ['en-us', 'en-gb', 'en-au', 'en-ie', 'en-in'];
  const index = order.indexOf(language.toLowerCase().replace('_', '-'));
  return index < 0 ? order.length : index;
}

function label(voice: SystemVoice): string {
  const region = voice.language.split(/[-_]/)[1]?.toUpperCase();
  const name = voice.name.toLowerCase().includes(voice.language.toLowerCase()) || !region ? voice.name : `${voice.name} · ${region}`;
  if (voice.identifier.includes('.premium.')) {
    return `${name} · Premium`;
  }
  if (voice.identifier.includes('.enhanced.')) {
    return `${name} · Enhanced`;
  }
  return name;
}

/** English voices worth reading a book with, best first. The saved voice always stays in the list. */
export function readingVoices(voices: SystemVoice[], selected?: string, limit = 16): VoiceChoice[] {
  const english = voices.filter((voice) => voice.language?.toLowerCase().startsWith('en') && !isNovelty(voice.identifier));
  const sorted = [...english].sort(
    (a, b) => tier(a) - tier(b) || localeRank(a.language) - localeRank(b.language) || a.name.localeCompare(b.name),
  );
  const picked = sorted.slice(0, limit);
  const saved = voices.find((voice) => voice.identifier === selected);
  if (saved && !picked.includes(saved)) {
    picked.push(saved);
  }
  return picked.map((voice) => ({ identifier: voice.identifier, label: label(voice) }));
}

/** iOS throws instead of speaking when a saved voice was removed from the device, so drop it. */
export function usableVoice(voices: SystemVoice[], selected?: string): string | undefined {
  if (!selected || !voices.length) {
    return selected;
  }
  return voices.some((voice) => voice.identifier === selected) ? selected : undefined;
}
