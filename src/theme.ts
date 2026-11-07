import type { ThemeName } from '@/lib/types';
import { useSettings } from '@/state/settings';

export type Palette = {
  bg: string;
  paper: string;
  ink: string;
  muted: string;
  line: string;
  accent: string;
  chip: string;
  danger: string;
};

export const palettes: Record<ThemeName, Palette> = {
  light: {
    bg: '#efeae2',
    paper: '#f7f4ee',
    ink: '#1c1915',
    muted: '#6f675e',
    line: '#e4d9cc',
    accent: '#8d3b32',
    chip: '#e7dfd3',
    danger: '#8d3b32',
  },
  sepia: {
    bg: '#ead9b8',
    paper: '#f4ead4',
    ink: '#3d2e1e',
    muted: '#7a6148',
    line: '#e0cfae',
    accent: '#8a4528',
    chip: '#e6d3ae',
    danger: '#8a4528',
  },
  dark: {
    bg: '#100f0d',
    paper: '#1b1a17',
    ink: '#efe6d8',
    muted: '#a89d90',
    line: '#2c2924',
    accent: '#e2a56a',
    chip: '#26231e',
    danger: '#e2a56a',
  },
};

export function usePalette(): Palette {
  const { settings } = useSettings();
  return palettes[settings.theme];
}
