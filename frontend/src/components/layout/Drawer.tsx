import { type ReactNode, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import styles from './Drawer.module.css';

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}

export function Drawer({ open, onClose, children }: DrawerProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  return (
    <>
      <div
        className={`${styles.overlay} ${open ? styles.visible : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={ref}
        className={`${styles.drawer} ${open ? styles.open : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation menu"
      >
        <div className={styles.header}>
          <span className={styles.logo}>
            <img src="/logo.png" alt="" className={styles.logoMark} aria-hidden="true" />
            <span className={styles.accent}>the</span>bookdex
          </span>
          <button onClick={onClose} className={styles.close} aria-label="Close menu">
            <X size={24} />
          </button>
        </div>
        {children}
      </div>
    </>
  );
}
