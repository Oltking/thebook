import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const KEY = 'thebook-theme';

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
 */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => stored() ?? 'light');

  // Always stamp the resolved theme so light truly wins by default, rather than
  // leaving it unset and letting the OS media query hand dark-mode users dark.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* ignore */
    }
    document.documentElement.setAttribute('data-theme', next);
    setThemeState(next);
  }, []);

  const toggle = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  return { theme, setTheme, toggle };
}
