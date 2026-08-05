import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const KEY = 'thebook-theme';
// Fired whenever any component flips the theme, so every other useTheme() instance
// (the header toggle, the chart, the depth canvas, ...) updates in the same tick
// instead of only on the next page load.
const EVENT = 'thebookdex:theme';

function stored(): Theme | null {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : null;
  } catch {
    return null;
  }
}

/**
 * Full light/dark toggle. Light is the default for anyone who has not chosen
 * otherwise (we do not follow the OS), and an explicit choice is persisted in
 * localStorage. Either way we stamp `data-theme` on <html>, which the CSS token
 * scopes read, so the resolved theme is always concrete.
 *
 * useState is component-local, so multiple useTheme() callers each hold their own
 * copy. To keep them in sync we broadcast a custom event on every change (and also
 * listen for cross-tab `storage` events); every instance updates its own state when
 * it hears one. Without this, a consumer like the price chart would keep painting
 * the old theme until the page was refreshed.
 */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => stored() ?? 'light');

  // Always stamp the resolved theme so light truly wins by default, rather than
  // leaving it unset and letting the OS media query hand dark-mode users dark.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Sync this instance when another instance (or another tab) changes the theme.
  useEffect(() => {
    const onEvent = (e: Event) => {
      const next = (e as CustomEvent<Theme>).detail;
      if (next === 'light' || next === 'dark') setThemeState(next);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY && (e.newValue === 'light' || e.newValue === 'dark')) {
        setThemeState(e.newValue);
      }
    };
    window.addEventListener(EVENT, onEvent);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(EVENT, onEvent);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const setTheme = useCallback((next: Theme) => {
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* ignore */
    }
    document.documentElement.setAttribute('data-theme', next);
    setThemeState(next);
    // Let every other useTheme() instance in this tab update immediately.
    window.dispatchEvent(new CustomEvent<Theme>(EVENT, { detail: next }));
  }, []);

  const toggle = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  return { theme, setTheme, toggle };
}
