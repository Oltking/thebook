import { useEffect, useRef } from 'react';

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

  useEffect(() => {
    if (!active) return;
    const node = ref.current;
    const prevFocus = document.activeElement as HTMLElement | null;

    // Move focus into the dialog.
    const focusables = () => Array.from(node?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    const first = focusables()[0];
    (first ?? node)?.focus?.();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && onEscape) { onEscape(); return; }
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
  }, [active, onEscape]);

  return ref;
}
