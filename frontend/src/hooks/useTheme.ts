import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const KEY = 'thebook-theme';

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function stored(): Theme | null {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : null;
  } catch {
    return null;
  }
}

/**
 * Full light/dark toggle. Persists the explicit choice in localStorage and
 * stamps `data-theme` on <html> (which the CSS token scopes read). When the
 * user has made no choice, follows the OS preference and tracks live changes.
 */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => stored() ?? systemTheme());

  // Apply to <html>. Only stamp an explicit attribute when the user has chosen;
  // otherwise leave it unset so the media query drives things.
  useEffect(() => {
    const explicit = stored();
    if (explicit) document.documentElement.setAttribute('data-theme', explicit);
    else document.documentElement.removeAttribute('data-theme');
  }, [theme]);

  // Follow the OS when the user hasn't overridden it.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (!stored()) setThemeState(systemTheme());
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

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
