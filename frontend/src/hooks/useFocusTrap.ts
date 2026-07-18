import { useEffect, useRef } from 'react';

// (implementation below keeps onEscape in a ref so the trap only (re)initializes
//  when `active` flips - not on every parent re-render.)

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Keep keyboard focus inside a modal while it's open, restore it on close, and
 * optionally close on Escape. Attach the returned ref to the dialog element.
 */
export function useFocusTrap<T extends HTMLElement = HTMLDivElement>(
  active: boolean,
  onEscape?: () => void,
) {
  const ref = useRef<T>(null);
  // Hold the latest onEscape without making it an effect dependency - otherwise a
  // parent that recreates the callback each render would re-run the trap (and
  // re-steal focus to the first element) on every keystroke.
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const node = ref.current;
    const prevFocus = document.activeElement as HTMLElement | null;

    // Move focus into the dialog.
    const focusables = () => Array.from(node?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    const first = focusables()[0];
    (first ?? node)?.focus?.();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && escapeRef.current) { escapeRef.current(); return; }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault(); lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault(); firstEl.focus();
      }
    };

    node?.addEventListener('keydown', onKeyDown);
    return () => {
      node?.removeEventListener('keydown', onKeyDown);
      prevFocus?.focus?.();
    };
  }, [active]);

  return ref;
}
