export type AudioMark = { startMs: number; title: string };

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

function readU64(bytes: Uint8Array, offset: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hi = view.getUint32(offset);
  const lo = view.getUint32(offset + 4);
  return hi * 2 ** 32 + lo;
}

function findAtoms(bytes: Uint8Array, type: string): Uint8Array[] {
  const hits: Uint8Array[] = [];
  const visit = (start: number, end: number) => {
    let offset = start;
    while (offset + 8 <= end) {
      let size = readU32(bytes, offset);
      const kind = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
      let header = 8;
      if (size === 1 && offset + 16 <= end) {
        size = readU64(bytes, offset + 8);
        header = 16;
      }
      if (size < header || offset + size > end + 8) break;
      const payloadStart = offset + header;
      const payloadEnd = offset + size;
      if (kind === type) hits.push(bytes.subarray(payloadStart, payloadEnd));
      if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'edts'].includes(kind)) {
        visit(payloadStart, payloadEnd);
      }
      offset += size;
    }
  };
  visit(0, bytes.length);
  return hits;
}

function tryChapters(payload: Uint8Array, countAt: number): AudioMark[] | null {
  if (countAt >= payload.length) return null;
  const count = payload[countAt];
  if (count < 1 || count > 250) return null;
  const chapters: AudioMark[] = [];
  let pos = countAt + 1;
  for (let i = 0; i < count; i += 1) {
    if (pos + 9 > payload.length) return null;
    const start = readU64(payload, pos);
    pos += 8;
    const length = payload[pos];
    pos += 1;
    if (pos + length > payload.length) return null;
    const title = new TextDecoder().decode(payload.subarray(pos, pos + length)).trim() || `Chapter ${i + 1}`;
    pos += length;
    chapters.push({ startMs: Math.round(start / 10_000), title });
  }
  return chapters;
}

/** Read Nero-style `chpl` chapters from an M4B/M4A, when the file has them. */
export function m4bChapters(bytes: Uint8Array): AudioMark[] {
  for (const payload of findAtoms(bytes, 'chpl')) {
    const parsed = tryChapters(payload, 8) ?? tryChapters(payload, 4);
    if (parsed?.length) return parsed;
  }
  return [];
}
