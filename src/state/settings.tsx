import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { mergeSettings, type Settings } from '@/lib/types';
import { useLibrary } from '@/state/library';

type SettingsContextValue = {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
};

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const { io, ready } = useLibrary();
  const [settings, setSettings] = useState<Settings>(mergeSettings(null));

  useEffect(() => {
    if (!ready) return;
    io.readText('settings.json')
      .then((raw) => {
        if (!raw) return;
        const parsed = JSON.parse(raw) as Partial<Settings> & { readAlongHighlight?: unknown };
        const next = mergeSettings(parsed);
        setSettings(next);
        if ('readAlongHighlight' in parsed || parsed.version !== next.version) {
          io.writeText('settings.json', JSON.stringify(next)).catch(() => undefined);
        }
      })
      .catch(() => undefined);
  }, [io, ready]);

  const update = (patch: Partial<Settings>) => {
    setSettings((current) => {
      const next = mergeSettings({ ...current, ...patch });
      io.writeText('settings.json', JSON.stringify(next)).catch(() => undefined);
      return next;
    });
  };

  const value = useMemo(() => ({ settings, update }), [settings]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext);
  if (!value) throw new Error('Settings are not ready.');
  return value;
}
