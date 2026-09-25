import { useLayoutEffect } from 'react';
import type { ThemePreference } from './types';

export const THEME_PREFERENCES: ThemePreference[] = ['system', 'light', 'dark'];

const darkQuery = () => window.matchMedia?.('(prefers-color-scheme: dark)');

export function applyTheme(preference: ThemePreference) {
  const dark =
    preference === 'dark' || (preference === 'system' && !!darkQuery()?.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

// Keeps <html data-theme> in sync with the preference, and with the OS
// setting while the preference is "system".
export function useTheme(preference: ThemePreference) {
  // Layout effect: applied before the first paint, so there's no theme flash.
  useLayoutEffect(() => {
    applyTheme(preference);
    if (preference !== 'system') return;
    const query = darkQuery();
    if (!query) return;
    const onChange = () => applyTheme('system');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [preference]);
}
