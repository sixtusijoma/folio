import { XMLParser } from 'fast-xml-parser';
import JSZip from 'jszip';

import { wrapSentences, wordCount } from '@/lib/html';

export type ParsedChapter = {
  title: string;
  html: string;
  sentences: number;
};

export type ParsedBook = {
  title: string;
  author: string;
  cover?: { bytes: Uint8Array; mime: string };
  chapters: ParsedChapter[];
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
});

function list<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function attr(node: Record<string, unknown> | undefined, name: string): string {
  if (!node) return '';
  const value = node[`@_${name}`];
  return typeof value === 'string' ? value : '';
}

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node || typeof node !== 'object') return '';
  const record = node as Record<string, unknown>;
  if (typeof record['#text'] === 'string') return record['#text'];
  return '';
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index >= 0 ? path.slice(0, index) : '';
}

function joinPath(base: string, href: string): string {
  const clean = href.split('#')[0];
  if (!base) return decodeURIComponent(clean);
  const parts = base.split('/').filter(Boolean);
  for (const part of clean.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.') parts.push(part);
  }
  return decodeURIComponent(parts.join('/'));
}

function mimeFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'svg') return 'image/svg+xml';
  return 'image/jpeg';
}

function bytesToDataUri(bytes: Uint8Array, mime: string): string {
  let binary = '';
  const stride = 0x8000;
  for (let i = 0; i < bytes.length; i += stride) {
    binary += String.fromCharCode(...bytes.subarray(i, i + stride));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

/** Drop footnote markers from headings so a title like "Energy" is not "Energy272". Body notes stay, so sentence indexes do not move. */
function stripTitleNotes(html: string): string {
  return html.replace(/<(h[1-6]|p)\b([^>]*)>([\s\S]*?)<\/\1>/gi, (match, tag: string, attrs: string, inner: string) => {
    const titled = /^h/i.test(tag) || /\btitle\b/i.test(attrs);
    if (!titled) return match;
    const cleaned = inner.replace(/<a\b[^>]*(?:noteref|doc-noteref)[^>]*>[\s\S]*?<\/a>/gi, '');
    return `<${tag}${attrs}>${cleaned}</${tag}>`;
  });
}

function sanitize(html: string, rewriteImage: (src: string) => string | null): string {
  const without = stripTitleNotes(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const body = without.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? without;
  const allowed = /^(p|h1|h2|h3|h4|h5|h6|blockquote|ul|ol|li|em|strong|i|b|br|img|a|figure|figcaption|hr|span|div|section)$/i;
  return body.replace(/<\/?([a-zA-Z0-9:-]+)([^>]*)>/g, (tag, name: string, rest: string) => {
    const clean = name.toLowerCase();
    if (!allowed.test(clean)) return '';
    if (clean === 'br' || clean === 'hr') return `<${clean}/>`;
    if (clean === 'img') {
      const src = /src\s*=\s*["']([^"']+)["']/i.exec(rest)?.[1] ?? '';
      const alt = /alt\s*=\s*["']([^"']*)["']/i.exec(rest)?.[1] ?? '';
      const next = rewriteImage(src);
      if (!next) return '';
      return `<img src="${next}" alt="${alt.replace(/"/g, '')}" decoding="async"/>`;
    }
    if (tag.startsWith('</')) return `</${clean}>`;
    return `<${clean}>`;
  });
}

async function readToc(zip: JSZip, opfDir: string, opf: Record<string, unknown>): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const manifest = list<Record<string, unknown>>(
    (opf.manifest as { item?: Record<string, unknown> | Record<string, unknown>[] } | undefined)?.item,
  );
  const navItem =
    manifest.find((item) => attr(item, 'properties').includes('nav')) ??
    manifest.find((item) => /toc/i.test(attr(item, 'href')));
  const href = attr(navItem, 'href');
  if (!href) return titles;
  const file = zip.file(joinPath(opfDir, href));
  if (!file) return titles;
  const html = await file.async('string');
  const pattern = /<a[^>]*href\s*=\s*["']([^"'#]+)(?:#[^"']*)?["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    const target = joinPath(dirname(joinPath(opfDir, href)), match[1]);
    const label = match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (label) titles.set(target, label);
  }
  return titles;
}

export async function parseEpub(bytes: Uint8Array): Promise<ParsedBook> {
  const zip = await JSZip.loadAsync(bytes);
  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) throw new Error('This EPUB is missing META-INF/container.xml.');
  const container = parser.parse(await containerFile.async('string')) as {
    container?: { rootfiles?: { rootfile?: Record<string, unknown> | Record<string, unknown>[] } };
  };
  const rootfile = list(container.container?.rootfiles?.rootfile)[0];
  const opfPath = attr(rootfile, 'full-path');
  if (!opfPath) throw new Error('This EPUB has no package document.');
  const opfFile = zip.file(opfPath);
  if (!opfFile) throw new Error('The EPUB package document is missing.');
  const opf = parser.parse(await opfFile.async('string')) as { package?: Record<string, unknown> };
  const pkg = opf.package ?? {};
  const metadata = (pkg.metadata ?? {}) as Record<string, unknown>;
  const title = textOf(list(metadata.title as unknown)[0] ?? metadata.title) || 'Untitled';
  const author = textOf(list(metadata.creator as unknown)[0] ?? metadata.creator) || 'Unknown author';
  const manifest = list<Record<string, unknown>>(
    (pkg.manifest as { item?: Record<string, unknown> | Record<string, unknown>[] } | undefined)?.item,
  );
  const byId = new Map(manifest.map((item) => [attr(item, 'id'), item]));
  const opfDir = dirname(opfPath);
  const toc = await readToc(zip, opfDir, pkg);

  let cover: ParsedBook['cover'];
  const coverItem =
    manifest.find((item) => attr(item, 'properties').includes('cover-image')) ??
    manifest.find((item) => attr(item, 'id') === 'cover-image' || /cover\.(jpe?g|png|webp)$/i.test(attr(item, 'href')));
  if (coverItem) {
    const coverPath = joinPath(opfDir, attr(coverItem, 'href'));
    const coverFile = zip.file(coverPath);
    if (coverFile) {
      const coverBytes = await coverFile.async('uint8array');
      if (coverBytes.byteLength < 1_500_000) {
        cover = { bytes: coverBytes, mime: attr(coverItem, 'media-type') || mimeFor(coverPath) };
      }
    }
  }

  const spine = list<Record<string, unknown>>(
    (pkg.spine as { itemref?: Record<string, unknown> | Record<string, unknown>[] } | undefined)?.itemref,
  );
  const raw: { title: string; html: string; words: number }[] = [];
  for (const ref of spine) {
    const item = byId.get(attr(ref, 'idref'));
    if (!item) continue;
    const href = attr(item, 'href');
    const media = attr(item, 'media-type');
    if (media && !media.includes('html') && !href.endsWith('.xhtml') && !href.endsWith('.html')) continue;
    if (/toc|nav/i.test(href) && attr(item, 'properties').includes('nav')) continue;
    const full = joinPath(opfDir, href);
    const file = zip.file(full);
    if (!file) continue;
    const source = await file.async('string');
    const base = dirname(full);
    let images = 0;
    const html = sanitize(source, (src) => {
      if (!src || src.startsWith('data:')) return src || null;
      if (images >= 6) return null;
      const imagePath = joinPath(base, src);
      const image = zip.file(imagePath);
      if (!image) return null;
      images += 1;
      return `__IMG__${imagePath}`;
    });
    const withImages = await replaceImageMarkers(html, zip);
    const words = wordCount(withImages);
    if (words < 8 && !withImages.includes('<img')) continue;
    raw.push({
      title: toc.get(full) || heading(withImages) || `Chapter ${raw.length + 1}`,
      html: withImages,
      words,
    });
  }

  const merged = mergeShortChapters(raw);
  const chapters = merged.map((chapter) => {
    const wrapped = wrapSentences(chapter.html);
    return { title: chapter.title, html: wrapped.html, sentences: wrapped.count };
  });
  if (!chapters.length) throw new Error('No readable chapters were found in this EPUB.');
  return { title, author, cover, chapters };
}

async function replaceImageMarkers(html: string, zip: JSZip): Promise<string> {
  const matches = [...html.matchAll(/__IMG__([^"']+)/g)];
  let next = html;
  for (const match of matches) {
    const path = match[1];
    const file = zip.file(path);
    if (!file) {
      next = next.replace(match[0], '');
      continue;
    }
    const bytes = await file.async('uint8array');
    if (bytes.byteLength > 450_000) {
      next = next.replace(match[0], '');
      continue;
    }
    next = next.replace(match[0], bytesToDataUri(bytes, mimeFor(path)));
  }
  return next;
}

function heading(html: string): string {
  const match = html.match(/<h[1-3]>([\s\S]*?)<\/h[1-3]>/i);
  return match ? match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
}

function mergeShortChapters(chapters: { title: string; html: string; words: number }[]) {
  const out: { title: string; html: string; words: number }[] = [];
  let bucket: { title: string; html: string; words: number } | null = null;
  const flush = () => {
    if (bucket) out.push(bucket);
    bucket = null;
  };
  for (const chapter of chapters) {
    if (chapter.words >= 380) {
      flush();
      out.push(chapter);
      continue;
    }
    if (!bucket) bucket = { ...chapter };
    else {
      bucket = {
        title: bucket.title,
        html: `${bucket.html}${chapter.html}`,
        words: bucket.words + chapter.words,
      };
      if (bucket.words >= 1400) flush();
    }
  }
  flush();
  return out;
}
