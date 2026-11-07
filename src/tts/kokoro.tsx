import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import type { WebViewMessageEvent } from 'react-native-webview';

import { FolioWebView, type FolioWebHandle } from '@/components/folioWeb';

import { base64ToBytes } from '@/lib/wav';

export const KOKORO_VOICES = [
  { id: 'af_heart', label: 'Heart · American woman' },
  { id: 'af_bella', label: 'Bella · American woman' },
  { id: 'af_nicole', label: 'Nicole · American woman' },
  { id: 'am_michael', label: 'Michael · American man' },
  { id: 'am_fenrir', label: 'Fenrir · American man' },
  { id: 'bf_emma', label: 'Emma · British woman' },
  { id: 'bm_george', label: 'George · British man' },
];

type Pending = {
  resolve: (bytes: Uint8Array) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  limitMs: number;
  failure: string;
};

type Status = { state: 'idle' | 'loading' | 'ready' | 'error'; progress: number; message: string };

// A download counts as stalled when no progress arrives for this long, however big the model is.
const STALL_MS = 90000;
const SENTENCE_MS = 45000;
const QUEUE_MS = 240000;

const pending = new Map<string, Pending>();
const listeners = new Set<(status: Status) => void>();
const outbox: string[] = [];
let webview: FolioWebHandle | null = null;
let pageReady = false;
let status: Status = { state: 'idle', progress: 0, message: 'Kokoro has not been downloaded.' };

function emit(next: Status) {
  status = next;
  listeners.forEach((listener) => listener(status));
}

export function kokoroStatus(): Status {
  return status;
}

export function subscribeKokoro(listener: (status: Status) => void): () => void {
  listeners.add(listener);
  listener(status);
  return () => listeners.delete(listener);
}

// q8 is the ONNX build kokoro-js recommends for wasm. q4 is three times the download and pushes the
// WebView past the memory iOS allows a web content process, so iOS kills it mid-load.
const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body>
<script type="module">
const post = (msg) => {
  const data = JSON.stringify(msg);
  if (window.ReactNativeWebView) {
    window.ReactNativeWebView.postMessage(data);
  } else {
    window.parent.postMessage(data, '*');
  }
};
let model = null;
let loading = null;
let lastPercent = -1;
function report(info) {
  const file = info && info.file ? info.file : '';
  const percent = info && typeof info.progress === 'number' ? Math.floor(info.progress) : 0;
  if (!file.endsWith('.onnx') || percent === lastPercent) {
    return;
  }
  lastPercent = percent;
  post({ type: 'status', state: 'loading', progress: percent / 100 });
}
async function ensure() {
  if (model) {
    return model;
  }
  if (!loading) {
    loading = (async () => {
      post({ type: 'status', state: 'loading', progress: 0 });
      const mod = await import('https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm');
      model = await mod.KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
        dtype: 'q8',
        device: 'wasm',
        progress_callback: report,
      });
      post({ type: 'status', state: 'ready', progress: 1 });
      return model;
    })().catch((error) => {
      loading = null;
      lastPercent = -1;
      post({ type: 'status', state: 'error', message: String(error && error.message || error) });
      throw error;
    });
  }
  return loading;
}
function wav16(samples, rate) {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Uint8Array(view.buffer);
}
function toBase64(bytes) {
  let binary = '';
  const stride = 0x8000;
  for (let i = 0; i < bytes.length; i += stride) {
    binary += String.fromCharCode(...bytes.subarray(i, i + stride));
  }
  return btoa(binary);
}
async function handle(msg) {
  post({ type: 'start', id: msg.id });
  try {
    const tts = await ensure();
    if (msg.type === 'prepare') {
      post({ type: 'done', id: msg.id });
      return;
    }
    const audio = await tts.generate(msg.text, { voice: msg.voice || 'af_heart' });
    if (!audio || !audio.audio || !audio.audio.length) {
      throw new Error('Kokoro returned no audio.');
    }
    post({ type: 'audio', id: msg.id, b64: toBase64(wav16(audio.audio, audio.sampling_rate || 24000)) });
  } catch (error) {
    post({ type: 'error', id: msg.id, message: String(error && error.message || error) });
  }
}
let queue = Promise.resolve();
window.__folioTts = (raw) => {
  const msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
  queue = queue.then(() => handle(msg));
};
post({ type: 'status', state: 'idle', progress: 0 });
</script></body></html>`;

function inject(payload: string) {
  webview?.injectJavaScript(`window.__folioTts && window.__folioTts(${JSON.stringify(payload)}); true;`);
}

function send(command: object) {
  const payload = JSON.stringify(command);
  if (webview && pageReady) {
    inject(payload);
    return;
  }
  outbox.push(payload);
}

function flush() {
  while (webview && pageReady && outbox.length) {
    inject(outbox.shift() as string);
  }
}

function arm(id: string, ms: number) {
  const waiter = pending.get(id);
  if (!waiter) {
    return;
  }
  clearTimeout(waiter.timer);
  waiter.timer = setTimeout(() => {
    pending.delete(id);
    waiter.reject(new Error(waiter.failure));
  }, ms);
}

/** The page works through requests one at a time. limitMs counts from when it starts on this one. */
function request(command: { type: 'prepare' } | { type: 'speak'; text: string; voice: string }, limitMs: number, failure: string): Promise<Uint8Array> {
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, limitMs, failure });
    arm(id, QUEUE_MS);
    send({ ...command, id });
  });
}

export function prepareKokoro(): Promise<void> {
  return request({ type: 'prepare' }, STALL_MS, 'Kokoro stopped downloading. Check the connection and try again.').then(() => undefined);
}

export function synthesizeKokoro(text: string, voice: string): Promise<Uint8Array> {
  const limit = status.state === 'ready' ? Math.max(SENTENCE_MS, text.length * 250) : STALL_MS;
  return request({ type: 'speak', text, voice }, limit, 'Kokoro did not finish that sentence.');
}

function statusMessage(state: Status['state'], progress: number, error?: string): string {
  if (state === 'ready') {
    return 'Kokoro is on this device.';
  }
  if (state === 'loading') {
    return progress > 0 ? `Downloading Kokoro… ${Math.round(progress * 100)}%` : 'Downloading Kokoro…';
  }
  if (state === 'error') {
    return error || 'Kokoro failed to load.';
  }
  return 'Kokoro downloads the first time you use it.';
}

function onMessage(event: WebViewMessageEvent) {
  let message: { type?: string; id?: string; b64?: string; message?: string; state?: Status['state']; progress?: number };
  try {
    message = JSON.parse(event.nativeEvent.data);
  } catch {
    return;
  }
  if (message.type === 'status' && message.state) {
    const progress = message.progress ?? status.progress;
    emit({ state: message.state, progress, message: statusMessage(message.state, progress, message.message) });
    if (message.state === 'idle') {
      pageReady = true;
      flush();
    }
    if (message.state === 'loading') {
      pending.forEach((_, id) => arm(id, STALL_MS));
    }
  }
  if (!message.id) {
    return;
  }
  const waiter = pending.get(message.id);
  if (!waiter) {
    return;
  }
  if (message.type === 'start') {
    arm(message.id, waiter.limitMs);
    return;
  }
  clearTimeout(waiter.timer);
  pending.delete(message.id);
  if (message.type === 'audio' && message.b64) {
    waiter.resolve(base64ToBytes(message.b64));
  } else if (message.type === 'done') {
    waiter.resolve(new Uint8Array());
  } else {
    waiter.reject(new Error(message.message || 'Kokoro failed.'));
  }
}

/** The OS can end the WebView's process, most often for memory. That page is gone for good. */
function stopAll() {
  pageReady = false;
  webview = null;
  outbox.length = 0;
  pending.forEach((waiter) => {
    clearTimeout(waiter.timer);
    waiter.reject(new Error('Kokoro was stopped by the system.'));
  });
  pending.clear();
  emit({ state: 'idle', progress: 0, message: 'Kokoro was stopped by the system and will load again when you use it.' });
}

export function KokoroHost() {
  const ref = useRef<FolioWebHandle>(null);
  const [generation, setGeneration] = useState(0);
  const onProcessGone = useCallback(() => {
    stopAll();
    setGeneration((value) => value + 1);
  }, []);
  useEffect(() => {
    const mounted = ref.current;
    webview = mounted;
    flush();
    return () => {
      if (webview === mounted) {
        webview = null;
      }
    };
  });
  return (
    <View pointerEvents="none" style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}>
      <FolioWebView
        key={generation}
        ref={ref}
        originWhitelist={['*']}
        source={{ html: HTML, baseUrl: 'https://cdn.jsdelivr.net' }}
        onMessage={onMessage}
        javaScriptEnabled
        domStorageEnabled
        allowFileAccess
        mixedContentMode="always"
        onContentProcessDidTerminate={onProcessGone}
        onRenderProcessGone={onProcessGone}
        onLoadEnd={() => {
          webview = ref.current;
          flush();
        }}
      />
    </View>
  );
}
