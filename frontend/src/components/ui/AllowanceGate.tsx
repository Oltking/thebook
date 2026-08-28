import { useState, type ReactNode } from 'react';
import styles from './AllowanceGate.module.css';

interface Props {
  /** Current on-chain allowance of the escrow token to the DEX (smallest-units). */
  allowance: bigint;
  /** Amount the pending order needs to escrow (smallest-units). */
  needed: bigint;
  /** Token symbol for the button label, e.g. "wUSDT". */
  symbol: string;
  /** Send the approval; resolves once the tx lands. `amount` is what to approve. */
  onApprove: (amount: bigint) => Promise<unknown>;
  /** Human-readable amount being approved, e.g. "42.50 wUSDT". Shown to the user so
   *  the copy and the transaction cannot disagree. */
  amountLabel?: string;
  /** Called after a successful approval (refresh allowance, etc.). */
  onApproved?: () => void;
  /** The real submit control, shown once allowance covers `needed`. */
  children: ReactNode;
}

/**
 * Gates an order submit behind the required token approval. When the allowance
 * already covers the order it just renders the submit control; otherwise it shows an
 * Approve step first (the one extra tx a real spot CLOB needs before escrow).
 */
export function AllowanceGate({ allowance, needed, symbol, onApprove, amountLabel, onApproved, children }: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (needed <= 0n || allowance >= needed) return <>{children}</>;

  const approve = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onApprove(needed);
      onApproved?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.wrap}>
      <button type="button" className={styles.approve} disabled={busy} onClick={approve}>
        {busy ? 'Approving…' : `Approve ${symbol}`}
      </button>
      {/* The copy names the exact amount, because the approval is for exactly that
          amount. Saying "for this order" while sending an unlimited allowance was
          the consent problem in audit H-07. */}
      <p className={styles.hint}>
        Approves exactly {amountLabel ?? `the ${symbol} this order needs`} — the amount this order
        escrows, and nothing more. You approve again for your next order.
      </p>
      {err && <p className={styles.err}>{err}</p>}
    </div>
  );
}
