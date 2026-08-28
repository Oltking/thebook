import { useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import styles from './RiskBanner.module.css';

const DISMISS_KEY = 'thebook:risk-ack-v1';
const DOCS = 'https://github.com/Oltking/thebook/blob/master/docs';

function alreadyAcknowledged(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    // Private mode / blocked storage: show the notice rather than hide it.
    return false;
  }
}

/**
 * Risk notice shown until the user acknowledges it.
 *
 * The audit's M-13 finding was that the interface offered 20x leveraged perpetuals
 * with no risk disclosure, no terms, and no statement of who operates the venue or
 * where it may be used. Documents in the repository do not fix that on their own —
 * a disclosure nobody sees is not a disclosure — so the two things a user most needs
 * to know before their first trade are stated here, in the product, with links to
 * the full text.
 *
 * `variant="perps"` adds the leverage-specific warnings, which are the ones that
 * actually lose people their money.
 */
export function RiskBanner({ variant = 'spot' }: { variant?: 'spot' | 'perps' }) {
  const [dismissed, setDismissed] = useState(alreadyAcknowledged);
  if (dismissed) return null;

  const acknowledge = () => {
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* not essential */ }
    setDismissed(true);
  };

  return (
    <div className={styles.wrap} role="note" aria-label="Risk notice">
      <AlertTriangle className={styles.icon} size={18} aria-hidden="true" />
      <div className={styles.body}>
        <p className={styles.line}>
          <strong>Unaudited software, real funds.</strong> thebook has not had an independent
          professional audit. It is non-custodial: nobody can reverse a trade, recover a lost
          key, or refund a mistake.
        </p>
        {variant === 'perps' && (
          <p className={styles.line}>
            Leveraged positions can lose their entire margin, and are liquidated permissionlessly.
            The house reserve is your counterparty — if it runs short, winning positions are paid
            only what it can cover. Check reserve health before opening.
          </p>
        )}
        <p className={styles.links}>
          <a className={styles.link} href={`${DOCS}/risk-disclosure.md`} target="_blank" rel="noreferrer">
            Risk disclosure
          </a>
          <span className={styles.sep} aria-hidden="true">·</span>
          <a className={styles.link} href={`${DOCS}/terms.md`} target="_blank" rel="noreferrer">
            Terms
          </a>
        </p>
      </div>
      <button type="button" className={styles.close} onClick={acknowledge} aria-label="I understand, dismiss this notice">
        <X size={16} />
      </button>
    </div>
  );
}
