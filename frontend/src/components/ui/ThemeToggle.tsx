import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import styles from './ThemeToggle.module.css';

interface ThemeToggleProps {
  /** Extra class for context-specific placement (e.g. the landing bar). */
  className?: string;
  size?: number;
}

/**
 * Sun / moon switch. Follows the OS until the visitor picks a side, then sticks
 * to that choice (useTheme persists it and stamps data-theme on <html>). Shows
 * the icon of the theme you would switch TO, which is the convention people read
 * fastest.
 */
export function ThemeToggle({ className = '', size = 18 }: ThemeToggleProps) {
  const { theme, toggle } = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className={`${styles.toggle} ${className}`}
      onClick={toggle}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
    >
      {theme === 'dark' ? <Sun size={size} /> : <Moon size={size} />}
    </button>
  );
}
