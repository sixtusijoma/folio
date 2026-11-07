import { FOLLOW_BOTTOM, FOLLOW_TOP } from '@/lib/readerFollow';
import type { FontChoice, ThemeName } from '@/lib/types';

const PAPER: Record<ThemeName, { bg: string; ink: string }> = {
  light: { bg: '#f7f4ee', ink: '#1c1915' },
  sepia: { bg: '#f4ead4', ink: '#3d2e1e' },
  dark: { bg: '#161513', ink: '#efe6d8' },
};

export type ReaderDocumentOptions = {
  body: string;
  width: number;
  fontSize: number;
  lineHeight: number;
  margin: number;
  font: FontChoice;
  theme: ThemeName;
};

function hashBody(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Identity of the reader document. Playback position and viewport height are not part of it. */
export function readerDocumentKey(options: ReaderDocumentOptions): string {
  return [
    options.theme,
    options.font,
    options.fontSize,
    options.lineHeight,
    options.margin,
    Math.round(options.width),
    hashBody(options.body),
  ].join('|');
}

export function readerDocument(options: ReaderDocumentOptions): string {
  const palette = PAPER[options.theme];
  const font =
    options.font === 'sans'
      ? '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
      : '"Iowan Old Style", Palatino, "Palatino Linotype", Georgia, serif';
  const margin = options.margin;
  return `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/>
<style>
  html, body { margin: 0; height: 100%; background: ${palette.bg}; color: ${palette.ink}; overflow: hidden; }
  #scroller { height: 100%; overflow-x: hidden; overflow-y: auto; -webkit-overflow-scrolling: touch; }
  #flow {
    margin: ${margin}px;
    padding-bottom: 45vh;
    font-family: ${font};
    font-size: ${options.fontSize}px;
    line-height: ${options.lineHeight};
    text-rendering: optimizeLegibility;
  }
  h1, h2, h3, h4 { font-weight: 600; line-height: 1.2; margin: 0 0 0.6em; }
  p { margin: 0 0 0.85em; }
  img { max-width: 100%; height: auto; }
  a { color: inherit; }
</style>
</head>
<body>
<div id="scroller"><div id="flow">${options.body}</div></div>
<script>
  const TOP = ${FOLLOW_TOP};
  const BOTTOM = ${FOLLOW_BOTTOM};
  let following = true;
  let programmatic = false;
  const scroller = document.getElementById('scroller');
  const post = (msg) => {
    const data = JSON.stringify(msg);
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(data);
    else window.parent.postMessage(data, '*');
  };
  let scrollOrigin = 'restore';
  const ratioOf = () => {
    const range = scroller.scrollHeight - scroller.clientHeight;
    if (range <= 0) return 0;
    return Math.min(1, Math.max(0, scroller.scrollTop / range));
  };
  let reportTimer = 0;
  scroller.addEventListener('scroll', () => {
    const origin = scrollOrigin;
    clearTimeout(reportTimer);
    reportTimer = setTimeout(() => post({ type: 'scroll', ratio: ratioOf(), origin }), 120);
  }, { passive: true });
  const suspend = () => {
    scrollOrigin = 'user';
    programmatic = false;
    if (!following) return;
    following = false;
    post({ type: 'suspend' });
  };
  scroller.addEventListener('wheel', suspend, { passive: true });
  scroller.addEventListener('touchstart', suspend, { passive: true });
  scroller.addEventListener('pointerdown', suspend, { passive: true });
  const hold = (ms, origin) => {
    programmatic = true;
    scrollOrigin = origin;
    setTimeout(() => {
      programmatic = false;
      if (scrollOrigin === origin) scrollOrigin = 'restore';
    }, ms);
  };
  const place = (sentence, ratio) => {
    hold(200, 'restore');
    if (ratio != null && ratio >= 0) {
      const range = scroller.scrollHeight - scroller.clientHeight;
      scroller.scrollTop = range * Math.min(1, Math.max(0, ratio));
      return;
    }
    if (sentence == null || sentence < 0) return;
    const node = document.querySelector('.s[data-i="' + sentence + '"]');
    if (node) node.scrollIntoView({ block: 'center', behavior: 'auto' });
  };
  const follow = (index) => {
    if (!following) return;
    const node = document.querySelector('.s[data-i="' + index + '"]');
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const height = window.innerHeight || document.documentElement.clientHeight || 1;
    if (rect.top >= height * TOP && rect.bottom <= height * BOTTOM) return;
    hold(900, 'follow');
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  window.__folio = (msg) => {
    if (msg.type === 'place') place(msg.sentence, msg.ratio);
    if (msg.type === 'resume') following = true;
    if (msg.type === 'follow') follow(msg.sentence);
  };
</script>
</body>
</html>`;
}
