import styles from './MaintenanceNotice.module.css';
import { Logo } from './Logo';

/**
 * Shown instead of the app when `VITE_MAINTENANCE` is set.
 *
 * The kill switch exists because the audit's Phase 0 response begins with "take the
 * frontend offline", and there was no way to do that short of tearing down the
 * deployment. Flipping an environment variable and redeploying stops new deposits
 * without touching the chain — and deliberately says so, because pulling the
 * interface does not pull anyone's funds.
 */
export function MaintenanceNotice() {
  const reason = import.meta.env.VITE_MAINTENANCE_REASON as string | undefined;

  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <div className={styles.brand}>
          <Logo className={styles.logo} />
          <span className={styles.name}><span className={styles.accent}>the</span>book</span>
        </div>

        <h1 className={styles.title}>Trading is paused for maintenance</h1>

        <p className={styles.body}>
          {reason || 'We have taken the interface offline while we work on the exchange. This is a planned pause, not an outage.'}
        </p>

        <div className={styles.assure}>
          <h2 className={styles.subtitle}>Your funds are not held here</h2>
          <p className={styles.body}>
            thebook is non-custodial. Your tokens are in your own wallet, and anything
            an open order has escrowed, or a fill has credited to you, is recorded on
            chain in the contract — not in this interface. Taking the site down does
            not move, freeze, or affect any of it.
          </p>
          <p className={styles.body}>
            Cancelling an order and withdrawing a balance are never blocked by a pause,
            on chain or here. If you need to do either right now, you can call the
            contract directly with the SDK.
          </p>
        </div>

        <p className={styles.foot}>
          Status and updates:{' '}
          <a className={styles.link} href="https://github.com/Oltking/thebook" rel="noreferrer">
            github.com/Oltking/thebook
          </a>
        </p>
      </div>
    </div>
  );
}
