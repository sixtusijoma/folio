import { Directory, File, Paths } from 'expo-file-system';

import type { Io } from '@/lib/types';

function root(): Directory {
  const directory = new Directory(Paths.document, 'folio');
  if (!directory.exists) directory.create({ idempotent: true });
  return directory;
}

function locate(path: string): File {
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop();
  if (!name) throw new Error('Empty path.');
  let directory = root();
  for (const part of parts) {
    const next = new Directory(directory, part);
    if (!next.exists) next.create({ idempotent: true });
    directory = next;
  }
  return new File(directory, name);
}

export function createIo(): Io {
  return {
    async readText(path) {
      const file = locate(path);
      if (!file.exists) return null;
      return file.text();
    },
    async writeText(path, text) {
      const file = locate(path);
      if (file.exists) file.delete();
      file.create();
      await file.write(text);
    },
    async mutateText(path, update) {
      const current = await this.readText(path);
      await this.writeText(path, update(current));
    },
    async readBytes(path) {
      const file = locate(path);
      if (!file.exists) return null;
      return file.bytes();
    },
    async writeBytes(path, bytes) {
      const file = locate(path);
      if (file.exists) file.delete();
      file.create();
      await file.write(bytes);
    },
    async exists(path) {
      return locate(path).exists;
    },
    async remove(path) {
      const file = locate(path);
      if (file.exists) file.delete();
    },
    async uri(path) {
      const file = locate(path);
      return file.exists ? file.uri : null;
    },
  };
}
