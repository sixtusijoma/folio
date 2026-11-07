import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

import { escapeHtml, wrapSentences } from '@/lib/html';

export type ExtractedArticle = {
  title: string;
  author: string;
  html: string;
  sentences: number;
  sourceUrl: string;
};

function tweetId(url: string): string | null {
  const match = url.match(/(?:x|twitter)\.com\/[^/]+\/status(?:es)?\/(\d+)/i);
  return match?.[1] ?? null;
}

export function articleFromHtml(source: string, url: string): ExtractedArticle {
  const { document } = parseHTML(source);
  let title = '';
  let author = '';
  let content = '';
  try {
    const parsed = new Readability(document).parse();
    title = parsed?.title?.trim() || '';
    author = parsed?.byline?.trim() || '';
    content = parsed?.content || '';
  } catch {
    content = '';
  }
  if (!content) {
    const paragraphs = [...document.querySelectorAll('article p, main p, p')]
      .map((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter((paragraph) => paragraph.length > 40);
    content = paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('');
    title = title || (document.querySelector('title')?.textContent ?? '').trim();
  }
  if (!content.trim()) throw new Error('No article text could be extracted from that page.');
  const wrapped = wrapSentences(content);
  return {
    title: title || 'Saved article',
    author: author || hostOf(url),
    html: wrapped.html,
    sentences: wrapped.count,
    sourceUrl: url,
  };
}

export async function fetchArticle(url: string): Promise<ExtractedArticle> {
  const id = tweetId(url);
  if (id) {
    const post = await fetchPost(url, id);
    if (post) return post;
  }
  const response = await fetch(url, { headers: { accept: 'text/html' } });
  if (!response.ok) throw new Error(`The page returned ${response.status}.`);
  const html = await response.text();
  return articleFromHtml(html, url);
}

async function fetchPost(url: string, id: string): Promise<ExtractedArticle | null> {
  const endpoints = [`https://api.fxtwitter.com/status/${id}`, `https://api.vxtwitter.com/Twitter/status/${id}`];
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint);
      if (!response.ok) continue;
      const data = (await response.json()) as {
        tweet?: { text?: string; author?: { name?: string; screen_name?: string } };
        text?: string;
        user_name?: string;
        user_screen_name?: string;
      };
      const text = data.tweet?.text || data.text;
      if (!text) continue;
      const author = data.tweet?.author?.name || data.user_name || 'X';
      const handle = data.tweet?.author?.screen_name || data.user_screen_name;
      const wrapped = wrapSentences(`<p>${escapeHtml(text)}</p>`);
      return {
        title: handle ? `@${handle}` : 'X post',
        author,
        html: wrapped.html,
        sentences: wrapped.count,
        sourceUrl: url,
      };
    } catch {
      // Try the next public mirror, then the page itself.
    }
  }
  return null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'Article';
  }
}
