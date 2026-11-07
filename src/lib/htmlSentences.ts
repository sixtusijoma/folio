import { parseHTML } from 'linkedom';

export function sentencesFromHtml(html: string): string[] {
  const { document } = parseHTML(`<div id="root">${html}</div>`);
  const root = document.getElementById('root');
  if (!root) return [];
  const found = new Map<number, string>();
  for (const node of root.querySelectorAll('span.s')) {
    const index = Number(node.getAttribute('data-i'));
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text || Number.isNaN(index)) continue;
    found.set(index, text);
  }
  return [...found.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text);
}
