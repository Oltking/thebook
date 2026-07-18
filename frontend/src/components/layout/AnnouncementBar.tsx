import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import styles from './AnnouncementBar.module.css';
import { NETWORK_NAME, PROGRAM_ID_CONFIGURED } from '../../consts';

const LIVE_TEXT =
  `🚀 thebookdex is live on ${NETWORK_NAME} · Spot orderbook · AMM pools · on-chain perpetuals · ` +
  'Trade BTC · ETH · VARA with real, withdrawable testnet tokens · ' +
  'Powered by Vara Network on Gear Protocol · Create your agent to get started · ';

const UNCONFIGURED_TEXT =
  '⚠ Program ID is not configured - set VITE_PROGRAM_ID in your environment (see DEPLOY.md). ' +
  'Trading actions will fail until the frontend points at a deployed program. ';

const TEXT = PROGRAM_ID_CONFIGURED ? LIVE_TEXT : UNCONFIGURED_TEXT;

const SESSION_KEY = 'thebookdex:bar';

export function AnnouncementBar() {
  const [visible, setVisible] = useState(() => sessionStorage.getItem(SESSION_KEY) !== '1');

  useEffect(() => {
    if (!visible) {
      document.documentElement.style.setProperty('--announcement-height', '0px');
    }
  }, [visible]);

  if (!visible) return null;

  return (
    <div className={styles.bar} role="banner">
      <div className={styles.track}>
        <div className={styles.marquee}>
          <span>{TEXT}</span>
          <span aria-hidden="true">{TEXT}</span>
        </div>
      </div>
      <button
        className={styles.close}
        onClick={() => {
          sessionStorage.setItem(SESSION_KEY, '1');
          document.documentElement.style.setProperty('--announcement-height', '0px');
          setVisible(false);
        }}
        aria-label="Dismiss announcement"
      >
        <X size={13} />
      </button>
    </div>
  );
}
