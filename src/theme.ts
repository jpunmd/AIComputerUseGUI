import { useLayoutEffect } from 'react';
import type { Theme } from './types';

export const THEMES: Theme[] = ['light', 'dark'];

// The OS appearance, used only as the first-launch default; after that the
// user's saved choice wins.
export function osTheme(): Theme {
  return typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

// Sets <html data-theme>, which selects the palette in index.css. A layout
// effect applies it before the first paint, so there's no theme flash.
export function useTheme(theme: Theme) {
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
}
