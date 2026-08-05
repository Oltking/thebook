import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import styles from './Select.module.css';

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  ariaLabel?: string;
  /** Extra class on the root for width / context-specific placement. */
  className?: string;
}

/**
 * A custom, fully styled dropdown that replaces the native <select>. Native
 * selects can't be themed past their closed box (the option list is drawn by the
 * OS), so this renders its own trigger and listbox to match the app's look in both
 * themes. Keyboard-operable (Enter/Space/arrows/Escape) and closes on outside click.
 */
export function Select({ value, onChange, options, ariaLabel, className = '' }: SelectProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const selected = options.find(o => o.value === value);
  const selectedIndex = Math.max(0, options.findIndex(o => o.value === value));

  const close = useCallback(() => setOpen(false), []);

  // Close on outside click / Escape while open.
  useEffect(() => {
    if (!open) return;
    setActive(selectedIndex);
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open, close, selectedIndex]);

  const pick = (v: string) => { onChange(v); close(); };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(options.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(0, i - 1)); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(options[active].value); }
  };

  return (
    <div ref={rootRef} className={`${styles.root} ${className}`}>
      <button
        type="button"
        className={styles.trigger}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen(o => !o)}
        onKeyDown={onKeyDown}
      >
        <span className={styles.value}>{selected?.label ?? value}</span>
        <ChevronDown size={15} className={`${styles.caret} ${open ? styles.caretOpen : ''}`} aria-hidden="true" />
      </button>

      {open && (
        <ul className={styles.list} role="listbox" aria-label={ariaLabel}>
          {options.map((o, i) => (
            <li key={o.value} role="option" aria-selected={o.value === value}>
              <button
                type="button"
                className={`${styles.option} ${o.value === value ? styles.optionSelected : ''} ${i === active ? styles.optionActive : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o.value)}
              >
                <span>{o.label}</span>
                {o.value === value && <Check size={14} className={styles.checkIcon} aria-hidden="true" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
