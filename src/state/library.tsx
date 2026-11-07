import * as SplashScreen from 'expo-splash-screen';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { deleteItem, readLibrary, updateItem } from '@/lib/libraryStore';
import type { Io, LibraryItem } from '@/lib/types';
import { seedIfNeeded } from '@/seed/run';
import { createIo } from '@/storage/io';

SplashScreen.preventAutoHideAsync().catch(() => undefined);

type LibraryContextValue = {
  io: Io;
  items: LibraryItem[];
  ready: boolean;
  status: string;
  error: string | null;
  refresh: () => Promise<void>;
  patch: (id: string, next: Partial<LibraryItem>) => Promise<void>;
  remove: (id: string) => Promise<void>;
};

const LibraryContext = createContext<LibraryContextValue | null>(null);

export function LibraryProvider({ children }: { children: ReactNode }) {
  const io = useMemo(() => createIo(), []);
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState('Opening your library…');
  const [error, setError] = useState<string | null>(null);
  const issuedWrite = useRef(new Map<string, number>());

  const refresh = useCallback(async () => {
    setItems((await readLibrary(io)).items);
  }, [io]);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        await seedIfNeeded(io, (message) => {
          if (!cancel) setStatus(message);
        });
        if (!cancel) setItems((await readLibrary(io)).items);
      } catch (caught) {
        if (!cancel) setError(caught instanceof Error ? caught.message : 'The library could not be opened.');
      } finally {
        if (!cancel) setReady(true);
        SplashScreen.hideAsync().catch(() => undefined);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [io]);

  const patch = useCallback(
    async (id: string, next: Partial<LibraryItem>) => {
      const seq = (issuedWrite.current.get(id) ?? 0) + 1;
      issuedWrite.current.set(id, seq);
      setItems((current) => current.map((item) => (item.id === id ? { ...item, ...next } : item)));
      const updated = await updateItem(io, id, next);
      setItems((current) => {
        if (!updated || issuedWrite.current.get(id) !== seq) return current;
        return current.map((item) => (item.id === id ? updated : item));
      });
    },
    [io],
  );

  const remove = useCallback(
    async (id: string) => {
      issuedWrite.current.set(id, (issuedWrite.current.get(id) ?? 0) + 1);
      await deleteItem(io, id);
      setItems((current) => current.filter((item) => item.id !== id));
    },
    [io],
  );

  const value = useMemo(
    () => ({ io, items, ready, status, error, refresh, patch, remove }),
    [io, items, ready, status, error, refresh, patch, remove],
  );
  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary(): LibraryContextValue {
  const value = useContext(LibraryContext);
  if (!value) throw new Error('Library is not ready.');
  return value;
}
