import { useEffect, useState } from 'react';
import styles from './Sidebar.module.css';
import { NAV_ITEMS } from '../../consts';
import { useSails } from '../../hooks/useSails';

interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  /** Called after a nav item is picked — used to close the mobile drawer. */
  onNavigate?: () => void;
}

interface DexStatus {
  agents: number;
  trades: number;
  orders: number;
  running: boolean;
}

export function Sidebar({ activeTab, setActiveTab, onNavigate }: SidebarProps) {
  const { program, isReady } = useSails();
  const [status, setStatus] = useState<DexStatus | null>(null);

  useEffect(() => {
    if (!program || !isReady) return;
    let active = true;

    const fetch = () =>
      program.orderbook.getStatus().call()
        .then((r: any) => {
          if (!active || !r) return;
          setStatus({
            agents: Number(r[0]),
            trades: Number(r[1]),
            orders: Number(r[2]),
            running: Boolean(r[3]),
          });
        })
        .catch(() => {});

    fetch();
    const id = setInterval(() => { if (!document.hidden) fetch(); }, 10_000);
    return () => { active = false; clearInterval(id); };
  }, [program, isReady]);

  return (
    <aside className={styles.sidebar}>
      <nav className={styles.nav}>
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              className={`${styles.navItem} ${activeTab === item.id ? styles.active : ''}`}
              onClick={() => { setActiveTab(item.id); onNavigate?.(); }}
              aria-current={activeTab === item.id ? 'page' : undefined}
            >
              <Icon size={20} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
      <div className={styles.footer}>
        <div className={styles.marketStatus}>
          <div className={styles.label}>Market Status</div>
          <div className={styles.value} style={{ color: status?.running ? 'var(--buy-green, #26a69a)' : 'var(--text-secondary)' }}>
            {status ? (status.running ? 'Live' : 'Idle') : '—'}
          </div>
        </div>
        {status && (
          <>
            <div className={styles.marketStatus}>
              <div className={styles.label}>Traders</div>
              <div className={styles.value}>{status.agents}</div>
            </div>
            <div className={styles.marketStatus}>
              <div className={styles.label}>Trades</div>
              <div className={styles.value}>{status.trades}</div>
            </div>
            <div className={styles.marketStatus}>
              <div className={styles.label}>Open Orders</div>
              <div className={styles.value}>{status.orders}</div>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
