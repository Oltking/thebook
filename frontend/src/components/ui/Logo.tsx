import { useTheme } from '../../hooks/useTheme';

/**
 * Theme-aware brand mark. Light theme uses the light-background logo; dark theme
 * keeps the original. Only the active image is requested, so we never ship both.
 */
export function Logo({ className }: { className?: string }) {
  const { theme } = useTheme();
  const src = theme === 'dark' ? '/logo.png' : '/logo-light.png';
  return <img src={src} alt="" className={className} aria-hidden="true" />;
}
