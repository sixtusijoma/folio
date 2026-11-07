import { parseHTML } from 'linkedom';

import { splitSentences } from '@/lib/sentences';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'figcaption']);

function sentenceSpan(sentence: string, index: number): string {
  return `<span class="s" data-i="${index}">${escapeHtml(sentence)}</span>`;
}

/**
 * Wrap each sentence in a span. Inline emphasis stays around the words it already wrapped.
 */
export function wrapSentences(html: string, startIndex = 0): { html: string; count: number } {
  const { document } = parseHTML(`<div id="root">${html}</div>`);
  const root = document.getElementById('root');
  if (!root) return { html, count: 0 };
  let index = startIndex;
  const blocks = [...root.querySelectorAll([...BLOCKS].join(','))];
  for (const block of blocks) {
    if (block.querySelector([...BLOCKS].join(','))) continue;
    const text = (block.textContent ?? '').replace(/\s+/g, ' ').trim();
    const sentences = splitSentences(text);
    if (!sentences.length) continue;
    const pieces = sentences.map((sentence) => {
      const span = sentenceSpan(sentence, index);
      index += 1;
      return span;
    });
    block.innerHTML = pieces.join(' ');
  }
  return { html: root.innerHTML, count: index - startIndex };
}

export function scriptParagraphs(script: string): string[] {
  return script
    .trim()
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** Same sentence sequence the reader builds from a script. */
export function scriptSentences(script: string): string[] {
  return scriptParagraphs(script).flatMap((paragraph) => splitSentences(paragraph));
}

export function scriptToHtml(script: string): { html: string; count: number } {
  const html = scriptParagraphs(script).map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('');
  return wrapSentences(html);
}

export function stripTags(html: string): string {
  const { document } = parseHTML(`<div id="root">${html}</div>`);
  return (document.getElementById('root')?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function wordCount(html: string): number {
  const text = stripTags(html);
  if (!text) return 0;
  return text.split(/\s+/).length;
}
