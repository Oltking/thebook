import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccount } from '@gear-js/react-hooks';
import { useSails } from '../hooks/useSails';
import { useSpotPairs, useWalletBalances, useClaims, useTokenSymbols } from '../hooks/useSpot';
import { useSpotActions } from '../hooks/useSpotActions';
import { formatUnits } from '../lib/units';
import styles from './SpotPortfolioView.module.css';

export function SpotPortfolioView() {
  const { pairs } = useSpotPairs();
  const { program } = useSails();
  const { account } = useAccount();
  const actions = useSpotActions();

  // Every token across the curated markets, with its decimals.
  const { tokens, decimals } = useMemo(() => {
    const dec: Record<string, number> = {};
    for (const p of pairs) {
      dec[String(p.base)] = Number(p.base_dec);
      dec[String(p.quote)] = Number(p.quote_dec);
    }
    return { tokens: Object.keys(dec), decimals: dec };
  }, [pairs]);

  const symbols = useTokenSymbols(tokens);
  const { balances, refresh: refreshBalances } = useWalletBalances(tokens);
  const { claims, refresh: refreshClaims } = useClaims(tokens);

  const [orders, setOrders] = useState<SpotOrder[]>([]);
  const refreshOrders = useCallback(async () => {
    if (!program || !account) { setOrders([]); return; }
    try {
      const mine = await program.spot.getMyOrders().withAddress(account.decodedAddress).call();
      setOrders(Array.isArray(mine) ? mine : []);
    } catch { /* keep last */ }
  }, [program, account]);

  useEffect(() => {
    refreshOrders();
    const iv = setInterval(() => { if (!document.hidden) refreshOrders(); }, 6000);
    return () => clearInterval(iv);
  }, [refreshOrders]);

  const sym = (t: string) => symbols[t] ?? `${t.slice(0, 6)}…`;

  const withdraw = async (token: string) => {
    try {
      await actions.withdraw(token);
      refreshClaims();
      refreshBalances();
    } catch { /* surfaced via pending state */ }
  };

  const cancel = async (oid: bigint) => {
    try {
      await actions.cancelOrder(oid);
      refreshOrders();
      refreshClaims();
    } catch { /* ignore */ }
  };

  if (!account) {
    return (
      <div className={styles.wrap}>
        <div className={styles.panel}>
          <p className={styles.connect}>Connect a wallet to see your balances.</p>
        </div>
      </div>
    );
  }

  const claimable = tokens.filter((t) => (claims[t] ?? 0n) > 0n);
  const openOrders = orders.filter((o) => o.status === 'Open' || o.status === 'PartiallyFilled');

  return (
    <div className={styles.wrap}>
      <div className={styles.panel}>
        <p className={styles.section}>Wallet balances</p>
        {tokens.length === 0 ? (
          <p className={styles.empty}>No listed tokens yet.</p>
        ) : (
          tokens.map((t) => (
            <div key={t} className={styles.row}>
              <span className={styles.sym}>{sym(t)}</span>
              <span className={styles.amt}>{formatUnits(balances[t] ?? 0n, decimals[t] ?? 0)}</span>
            </div>
          ))
        )}
      </div>

      <div className={styles.panel}>
        <p className={styles.section}>Claimable (fills &amp; cancelled escrow)</p>
        {claimable.length === 0 ? (
          <p className={styles.empty}>Nothing to withdraw.</p>
        ) : (
          claimable.map((t) => (
            <div key={t} className={styles.row}>
              <span className={styles.sym}>{sym(t)}</span>
              <span className={styles.amt}>{formatUnits(claims[t] ?? 0n, decimals[t] ?? 0)}</span>
              <button className={styles.withdraw} disabled={actions.pending} onClick={() => withdraw(t)}>
                {actions.pending ? 'Withdrawing…' : 'Withdraw'}
              </button>
            </div>
          ))
        )}
      </div>

      <div className={styles.panel}>
        <p className={styles.section}>Open orders</p>
        {openOrders.length === 0 ? (
          <p className={styles.empty}>No open orders.</p>
        ) : (
          openOrders.map((o) => {
            const bd = decimals[String(pairs.find((p) => String(p.id) === String(o.pair_id))?.base)] ?? 0;
            const qd = decimals[String(pairs.find((p) => String(p.id) === String(o.pair_id))?.quote)] ?? 0;
            return (
              <div key={String(o.id)} className={styles.row}>
                <span className={styles.amt}>
                  {o.side} {formatUnits(BigInt(o.qty as any) - BigInt(o.filled as any), bd)} @{' '}
                  {formatUnits(BigInt(o.price as any), qd)}
                </span>
                <button className={styles.cancel} disabled={actions.pending} onClick={() => cancel(BigInt(o.id as any))}>
                  Cancel
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
