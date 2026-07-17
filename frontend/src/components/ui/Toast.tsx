import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import styles from './Toast.module.css';

type ToastType = 'success' | 'error' | 'info';

interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

interface ToastCtx {
  success: (msg: string) => void;
  error: (msg: string) => void;
  info: (msg: string) => void;
}

const ToastContext = createContext<ToastCtx>({ success: () => {}, error: () => {}, info: () => {} });

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const add = useCallback((message: string, type: ToastType) => {
    const id = nextId++;
    // Cap the stack so bursts of errors can't cover the screen.
    setToasts(prev => [...prev.slice(-3), { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  return (
    <ToastContext.Provider value={{
      success: (msg: string) => add(msg, 'success'),
      error: (msg: string) => add(msg, 'error'),
      info: (msg: string) => add(msg, 'info'),
    }}>
      {children}
      <div className={styles.container} aria-live="polite" aria-atomic="false">
        {toasts.map(t => (
          <div
            key={t.id}
            className={`${styles.toast} ${styles[t.type]}`}
            role={t.type === 'error' ? 'alert' : 'status'}
            onClick={() => dismiss(t.id)}
            title="Dismiss"
            style={{ cursor: 'pointer' }}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
