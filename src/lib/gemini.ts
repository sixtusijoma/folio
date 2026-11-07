import { base64ToBytes, ensureWav } from '@/lib/wav';

export const GEMINI_VOICES: { id: string; label: string }[] = [
  { id: 'Zephyr', label: 'Zephyr · Bright' },
  { id: 'Puck', label: 'Puck · Upbeat' },
  { id: 'Charon', label: 'Charon · Informative' },
  { id: 'Kore', label: 'Kore · Firm' },
  { id: 'Fenrir', label: 'Fenrir · Excitable' },
  { id: 'Leda', label: 'Leda · Youthful' },
  { id: 'Orus', label: 'Orus · Firm' },
  { id: 'Aoede', label: 'Aoede · Breezy' },
  { id: 'Callirrhoe', label: 'Callirrhoe · Easy-going' },
  { id: 'Autonoe', label: 'Autonoe · Bright' },
  { id: 'Enceladus', label: 'Enceladus · Breathy' },
  { id: 'Iapetus', label: 'Iapetus · Clear' },
  { id: 'Umbriel', label: 'Umbriel · Easy-going' },
  { id: 'Algieba', label: 'Algieba · Smooth' },
  { id: 'Despina', label: 'Despina · Smooth' },
  { id: 'Erinome', label: 'Erinome · Clear' },
  { id: 'Algenib', label: 'Algenib · Gravelly' },
  { id: 'Rasalgethi', label: 'Rasalgethi · Informative' },
  { id: 'Laomedeia', label: 'Laomedeia · Upbeat' },
  { id: 'Achernar', label: 'Achernar · Soft' },
  { id: 'Alnilam', label: 'Alnilam · Firm' },
  { id: 'Schedar', label: 'Schedar · Even' },
  { id: 'Gacrux', label: 'Gacrux · Mature' },
  { id: 'Pulcherrima', label: 'Pulcherrima · Forward' },
  { id: 'Achird', label: 'Achird · Friendly' },
  { id: 'Zubenelgenubi', label: 'Zubenelgenubi · Casual' },
  { id: 'Vindemiatrix', label: 'Vindemiatrix · Gentle' },
  { id: 'Sadachbia', label: 'Sadachbia · Lively' },
  { id: 'Sadaltager', label: 'Sadaltager · Knowledgeable' },
  { id: 'Sulafat', label: 'Sulafat · Warm' },
];

export const GEMINI_MODELS = [
  { id: 'gemini-3.8-flash-lite-tts', label: 'Flash-Lite · faster, made for read-aloud' },
  { id: 'gemini-3.8-flash-tts', label: 'Flash · higher fidelity' },
];

export class GeminiError extends Error {
  status: number;
  retryable: boolean;
  quota: boolean;

  constructor(message: string, status: number, retryable: boolean, quota: boolean) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
    this.retryable = retryable;
    this.quota = quota;
  }
}

export function classifyGeminiFailure(status: number, body: string): { retryable: boolean; quota: boolean; message: string } {
  const lower = body.toLowerCase();
  const quota =
    status === 429 ||
    lower.includes('resource_exhausted') ||
    lower.includes('quota') ||
    lower.includes('rate limit') ||
    lower.includes('too many requests');
  const retryable = quota || status === 408 || status === 500 || status === 503 || status === 504;
  let message = 'Gemini could not speak that passage.';
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed.error?.message) message = parsed.error.message;
  } catch {
    if (body.trim()) message = body.trim().slice(0, 280);
  }
  if (quota) message = 'Gemini rate limit or free-tier quota was hit.';
  return { retryable, quota, message };
}

function collectAudio(value: unknown, found: { data?: string; mime?: string }[]) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry) => collectAudio(entry, found));
    return;
  }
  const record = value as Record<string, unknown>;
  const data =
    (typeof record.data === 'string' && record.data) ||
    (typeof record.bytes === 'string' && record.bytes) ||
    '';
  const mime = typeof record.mimeType === 'string' ? record.mimeType : typeof record.mime_type === 'string' ? record.mime_type : '';
  const type = typeof record.type === 'string' ? record.type : '';
  if (data && (type === 'audio' || mime.includes('audio') || mime.includes('l16') || record.inlineData)) {
    found.push({ data, mime });
  }
  const inline = record.inlineData as { data?: string; mimeType?: string } | undefined;
  if (inline?.data) found.push({ data: inline.data, mime: inline.mimeType });
  for (const nested of Object.values(record)) collectAudio(nested, found);
}

export function audioFromGeminiResponse(payload: unknown, sampleRate = 24000): Uint8Array {
  const found: { data?: string; mime?: string }[] = [];
  collectAudio(payload, found);
  const hit = found.find((entry) => entry.data && entry.data.length > 32);
  if (!hit?.data) throw new GeminiError('Gemini returned no audio.', 200, false, false);
  const bytes = ensureWav(base64ToBytes(hit.data), sampleRate);
  if (bytes.length < 48) throw new GeminiError('Gemini returned an empty clip.', 200, true, false);
  return bytes;
}

function useLegacy(model: string): boolean {
  return model.includes('2.5') || model.includes('preview-tts');
}

async function request(url: string, apiKey: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    const failure = classifyGeminiFailure(response.status, text);
    throw new GeminiError(failure.message, response.status, failure.retryable, failure.quota);
  }
  return JSON.parse(text) as unknown;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function synthesizeGemini(options: {
  apiKey: string;
  model: string;
  voice: string;
  text: string;
  sampleRate?: number;
}): Promise<Uint8Array> {
  const sampleRate = options.sampleRate ?? 24000;
  let last: GeminiError | null = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const payload = useLegacy(options.model)
        ? await request(
            `https://generativelanguage.googleapis.com/v1beta/models/${options.model}:generateContent`,
            options.apiKey,
            {
              contents: [{ parts: [{ text: options.text }] }],
              generationConfig: {
                responseModalities: ['AUDIO'],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voice } } },
              },
            },
          )
        : await request('https://generativelanguage.googleapis.com/v1beta/interactions', options.apiKey, {
            model: options.model,
            input: [
              {
                type: 'user_input',
                content: [
                  {
                    type: 'text',
                    text: options.text,
                    annotations: [{ type: 'speech_metadata', style: 'clear narration, steady pace, reading aloud' }],
                  },
                ],
              },
            ],
            response_format: { type: 'audio', mime_type: 'audio/l16', sample_rate: sampleRate },
            generation_config: { speech_config: [{ voice: options.voice }] },
          });
      return audioFromGeminiResponse(payload, sampleRate);
    } catch (error) {
      const gemini = error instanceof GeminiError ? error : new GeminiError(String(error), 0, true, false);
      last = gemini;
      if (!gemini.retryable || attempt === 3) throw gemini;
      await sleep(800 * 2 ** attempt);
    }
  }
  throw last ?? new GeminiError('Gemini failed.', 0, false, false);
}
