import type { Io } from '@/lib/types';

export function memoryIo(): Io {
  const files = new Map<string, Uint8Array>();
  const urls = new Map<string, string>();
  return {
    async readText(path) {
      const bytes = files.get(path);
      return bytes ? new TextDecoder().decode(bytes) : null;
    },
    async writeText(path, text) {
      files.set(path, new TextEncoder().encode(text));
    },
    async mutateText(path, update) {
      const current = files.has(path) ? new TextDecoder().decode(files.get(path) as Uint8Array) : null;
      files.set(path, new TextEncoder().encode(update(current)));
    },
    async readBytes(path) {
      return files.get(path) ?? null;
    },
    async writeBytes(path, bytes) {
      files.set(path, bytes);
      urls.delete(path);
    },
    async exists(path) {
      return files.has(path);
    },
    async remove(path) {
      files.delete(path);
      urls.delete(path);
    },
    async uri(path) {
      const bytes = files.get(path);
      if (!bytes) return null;
      const cached = urls.get(path);
      if (cached) return cached;
      const url = `memory:${path}`;
      urls.set(path, url);
      return url;
    },
  };
}
