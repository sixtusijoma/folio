export type ParsedMemo = {
  title: string;
  dateLabel: string;
  description?: string;
  sourceUrl: string;
  sources: string[];
  note?: string;
  spoken: string;
};

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8,
  oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

export function stripUrls(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function labeled(head: string[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const line of head) {
    const match = line.match(/^([A-Za-z][A-Za-z ]{0,40}):\s*(.+)$/);
    if (match) record[match[1].trim().toLowerCase()] = match[2].trim();
  }
  return record;
}

function urlsIn(value: string): string[] {
  return value
    .split(/\s*;\s*|\s+/)
    .map((part) => part.trim())
    .filter((part) => /^https?:\/\//i.test(part));
}

/** Header, then ---, then the words to narrate. URLs in the spoken half are dropped. */
export function parseMemo(raw: string): ParsedMemo {
  const divider = raw.indexOf('\n---');
  if (divider < 0) throw new Error('Memo is missing the --- divider.');
  const head = raw.slice(0, divider).trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const fields = labeled(head);
  const spoken = stripUrls(raw.slice(divider).replace(/^\n?---\n?/, ''));
  if (fields.title || fields['release date']) {
    const sources = urlsIn(fields.sources || fields.source || '');
    const title = fields.title?.trim() ?? '';
    if (!title || !spoken) throw new Error('Memo needs a title and spoken text.');
    return {
      title,
      dateLabel: fields['release date'] || fields.date || '',
      description: fields.description,
      sourceUrl: sources[0] ?? '',
      sources,
      spoken,
    };
  }
  const rawTitle = head[0] ?? '';
  const rewritten = rawTitle.match(/\((Rewritten [^)]+)\)\s*$/);
  const title = (rewritten ? rawTitle.slice(0, rewritten.index) : rawTitle).trim();
  const dateLabel = head[1] ?? '';
  const sources = head.flatMap((line) => urlsIn(line));
  if (!title || !spoken) throw new Error('Memo needs a title and spoken text.');
  return { title, dateLabel, sourceUrl: sources[0] ?? '', sources, note: rewritten?.[1], spoken };
}

/** US Eastern label to UTC. October dates are EDT (UTC-4). "After market close" is 4:00 PM ET. */
export function publishedAt(label: string): string {
  const match = label.match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})(?:[\s\S]*?(\d{1,2}):(\d{2})\s*(AM|PM))?/i);
  if (!match) return new Date().toISOString();
  const month = MONTHS[match[1].toLowerCase()];
  if (month == null) return new Date().toISOString();
  let hours: number;
  const minutes = match[5] ? Number(match[5]) : 0;
  if (match[4]) {
    hours = Number(match[4]);
    const ampm = (match[6] || '').toUpperCase();
    if (ampm === 'PM' && hours < 12) hours += 12;
    if (ampm === 'AM' && hours === 12) hours = 0;
  } else if (/after market close/i.test(label)) {
    hours = 16;
  } else {
    hours = 12;
  }
  const utc = new Date(Date.UTC(Number(match[3]), month, Number(match[2]), hours + 4, minutes));
  return utc.toISOString();
}
