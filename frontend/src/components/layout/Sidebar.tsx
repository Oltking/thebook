import { useEffect, useState } from 'react';
import styles from './Sidebar.module.css';
import { NAV_ITEMS } from '../../consts';
import { useSails } from '../../hooks/useSails';

interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  /** Called after a nav item is picked - used to close the mobile drawer. */
  onNavigate?: () => void;
}

/** Live venue health, read from the real spot CLOB. */
interface DexStatus {
  /** Curated markets. */
  pairs: number;
  /** Orders currently resting on the book (completed orders are not retained). */
  restingOrders: number;
  /** Global halt. Cancel and withdraw stay open while paused. */
  paused: boolean;
}

export function Sidebar({ activeTab, setActiveTab, onNavigate }: SidebarProps) {
  const { program, isReady } = useSails();
  const [status, setStatus] = useState<DexStatus | null>(null);

  useEffect(() => {
    if (!program || !isReady) return;
    let active = true;

    const fetch = async () => {
      try {
        const [pairs, restingOrders, paused] = await Promise.all([
          program.spot.pairCount().call(),
          program.spot.restingOrderCount().call(),
          program.spot.isPaused().call(),
        ]);
        if (!active) return;
        setStatus({
          pairs: Number(pairs),
          restingOrders: Number(restingOrders),
          paused: Boolean(paused),
        });
      } catch { /* keep the last good reading */ }
    };

    fetch();
    const id = setInterval(() => { if (!document.hidden) fetch(); }, 10_000);
    return () => { active = false; clearInterval(id); };
  }, [program, isReady]);

  return (
    <aside className={styles.sidebar}>
      <div className={styles.netWrap}>
        <div className={styles.netSwitch} role="group" aria-label="Network">
          <button className={styles.netActive} aria-pressed="true"><span>Mainnet</span></button>
        </div>
      </div>
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
          <div className={styles.label}>Venue</div>
          <div
            className={styles.value}
            style={{ color: status && !status.paused ? 'var(--buy-green, #26a69a)' : 'var(--sell-red)' }}
          >
            {status ? (status.paused ? 'Paused' : 'Live') : '-'}
          </div>
        </div>
        {status?.paused && (
          <div className={styles.marketStatus}>
            <div className={styles.label} style={{ gridColumn: '1 / -1' }}>
              Trading is halted. Cancelling orders and withdrawing stay open.
            </div>
          </div>
        )}
        {status && (
          <>
            <div className={styles.marketStatus}>
              <div className={styles.label}>Markets</div>
              <div className={styles.value}>{status.pairs}</div>
            </div>
            <div className={styles.marketStatus}>
              <div className={styles.label}>Resting Orders</div>
              <div className={styles.value}>{status.restingOrders}</div>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
