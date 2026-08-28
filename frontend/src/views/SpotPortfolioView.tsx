import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccount } from '@gear-js/react-hooks';
import { useSails } from '../hooks/useSails';
import {
  useSpotPairs,
  useWalletBalances,
  useClaims,
  useTokenSymbols,
  usePerpPositions,
} from '../hooks/useSpot';
import { useSpotActions } from '../hooks/useSpotActions';
import { formatUnits } from '../lib/units';
import styles from './SpotPortfolioView.module.css';

/**
 * Where the user's money actually is.
 *
 * This view used to show wallet balances and claimable balances only. Opening a
 * position or resting an order moves real tokens *out of the wallet* into the
 * contract — so a trader saw their balance drop with nothing here accounting for
 * it. The honest answer ("it is in the contract, backing your order") was invisible,
 * which is the worst possible combination on a venue holding real funds.
 *
 * Every token now shows the full breakdown, and the four parts add up to a total:
 *
 *   in wallet  +  in open orders  +  in positions  +  claimable  =  total
 */
export function SpotPortfolioView() {
  const { pairs } = useSpotPairs();
  const { program } = useSails();
  const { account } = useAccount();
  const actions = useSpotActions();
  const { positions } = usePerpPositions();

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
      const mine = await program.spot.getMyOrders(0, 200).withAddress(account.decodedAddress).call();
      setOrders(Array.isArray(mine) ? mine : []);
    } catch { /* keep last */ }
  }, [program, account]);

  useEffect(() => {
    refreshOrders();
    const iv = setInterval(() => { if (!document.hidden) refreshOrders(); }, 6000);
    return () => clearInterval(iv);
  }, [refreshOrders]);

  // Which token perp margin is escrowed in, so locked margin lands on the right row.
  const [collateral, setCollateral] = useState<string | null>(null);
  useEffect(() => {
    if (!program) return;
    let live = true;
    program.perpsV1.getConfig().call()
      .then(([token]) => { if (live) setCollateral(String(token)); })
      .catch(() => { /* perps not configured on this deployment */ });
    return () => { live = false; };
  }, [program]);

  const sym = (t: string) => symbols[t] ?? `${t.slice(0, 6)}…`;
  const pairOf = useCallback(
    (pairId: unknown) => pairs.find((p) => String(p.id) === String(pairId)),
    [pairs],
  );

  /**
   * Escrow still held by each resting order, per token.
   *
   * The contract tracks `escrowed` and `released` per order, so the amount still
   * held is exactly their difference — no need to re-derive it from price and
   * quantity and risk disagreeing with the chain.
   */
  const inOrders = useMemo(() => {
    const acc: Record<string, bigint> = {};
    for (const o of orders) {
      const pair = pairOf(o.pair_id);
      if (!pair) continue;
      const token = String(o.side === 'Buy' ? pair.quote : pair.base);
      const held = BigInt(o.escrowed as any) - BigInt(o.released as any);
      if (held > 0n) acc[token] = (acc[token] ?? 0n) + held;
    }
    return acc;
  }, [orders, pairOf]);

  /** Margin locked in open perp positions (always the collateral token). */
  const inPositions = useMemo(() => {
    if (!collateral) return {} as Record<string, bigint>;
    const total = positions.reduce((sum, p) => sum + p.margin, 0n);
    return total > 0n ? { [collateral]: total } : {};
  }, [positions, collateral]);

  const rows = useMemo(
    () =>
      tokens.map((t) => {
        const wallet = balances[t] ?? 0n;
        const orders_ = inOrders[t] ?? 0n;
        const posns = inPositions[t] ?? 0n;
        const claim = claims[t] ?? 0n;
        return {
          token: t,
          dec: decimals[t] ?? 0,
          wallet,
          orders: orders_,
          positions: posns,
          claim,
          total: wallet + orders_ + posns + claim,
        };
      }),
    [tokens, balances, inOrders, inPositions, claims, decimals],
  );

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
      refreshBalances();
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

  const claimable = rows.filter((r) => r.claim > 0n);
  const anyLocked = rows.some((r) => r.orders > 0n || r.positions > 0n);

  return (
    <div className={styles.wrap}>
      <div className={styles.panel}>
        <p className={styles.section}>Your funds</p>
        {rows.length === 0 ? (
          <p className={styles.empty}>No listed tokens yet.</p>
        ) : (
          <>
            <div className={`${styles.row} ${styles.head}`}>
              <span className={styles.sym}>Token</span>
              <span className={styles.cell}>In wallet</span>
              <span className={styles.cell}>In orders</span>
              <span className={styles.cell}>In positions</span>
              <span className={styles.cell}>Claimable</span>
              <span className={styles.cell}>Total</span>
            </div>
            {rows.map((r) => (
              <div key={r.token} className={styles.row}>
                <span className={styles.sym}>{sym(r.token)}</span>
                <span className={styles.cell}>{formatUnits(r.wallet, r.dec)}</span>
                <span className={`${styles.cell} ${r.orders > 0n ? styles.locked : styles.zero}`}>
                  {formatUnits(r.orders, r.dec)}
                </span>
                <span className={`${styles.cell} ${r.positions > 0n ? styles.locked : styles.zero}`}>
                  {formatUnits(r.positions, r.dec)}
                </span>
                <span className={`${styles.cell} ${r.claim > 0n ? styles.ready : styles.zero}`}>
                  {formatUnits(r.claim, r.dec)}
                </span>
                <span className={`${styles.cell} ${styles.total}`}>{formatUnits(r.total, r.dec)}</span>
              </div>
            ))}
          </>
        )}
        {anyLocked && (
          <p className={styles.note}>
            Tokens in orders and positions have left your wallet and are held by the exchange as
            escrow. Cancel an order or close a position to turn them back into a claimable balance,
            then withdraw. Neither is ever blocked, including while trading is paused.
          </p>
        )}
      </div>

      <div className={styles.panel}>
        <p className={styles.section}>Claimable (fills &amp; cancelled escrow)</p>
        {claimable.length === 0 ? (
          <p className={styles.empty}>Nothing to withdraw.</p>
        ) : (
          claimable.map((r) => (
            <div key={r.token} className={styles.row}>
              <span className={styles.sym}>{sym(r.token)}</span>
              <span className={styles.amt}>{formatUnits(r.claim, r.dec)}</span>
              <button className={styles.withdraw} disabled={actions.pending} onClick={() => withdraw(r.token)}>
                {actions.pending ? 'Withdrawing…' : 'Withdraw'}
              </button>
            </div>
          ))
        )}
      </div>

      <div className={styles.panel}>
        <p className={styles.section}>Open orders</p>
        {orders.length === 0 ? (
          <p className={styles.empty}>No open orders.</p>
        ) : (
          orders.map((o) => {
            const pair = pairOf(o.pair_id);
            const bd = pair ? Number(pair.base_dec) : 0;
            const qd = pair ? Number(pair.quote_dec) : 0;
            const remaining = BigInt(o.qty as any) - BigInt(o.filled as any);
            const escrowToken = pair ? String(o.side === 'Buy' ? pair.quote : pair.base) : '';
            const held = BigInt(o.escrowed as any) - BigInt(o.released as any);
            return (
              <div key={String(o.id)} className={styles.row}>
                <span className={styles.amt}>
                  {o.side} {formatUnits(remaining, bd)} @ {formatUnits(BigInt(o.price as any), qd)}
                  {held > 0n && escrowToken && (
                    <span className={styles.escrow}>
                      {' '}· {formatUnits(held, decimals[escrowToken] ?? 0)} {sym(escrowToken)} escrowed
                    </span>
                  )}
                </span>
                <button className={styles.cancel} disabled={actions.pending} onClick={() => cancel(BigInt(o.id as any))}>
                  Cancel
                </button>
              </div>
            );
          })
        )}
      </div>

      {positions.length > 0 && (
        <div className={styles.panel}>
          <p className={styles.section}>Open positions</p>
          {positions.map((p) => {
            const dec = collateral ? decimals[collateral] ?? 0 : 0;
            return (
              <div key={String(p.id)} className={styles.row}>
                <span className={styles.amt}>
                  {p.isLong ? 'Long' : 'Short'} {p.leverage}x · margin {formatUnits(p.margin, dec)}
                  {collateral ? ` ${sym(collateral)}` : ''}
                </span>
                <span className={p.pnl >= 0n ? styles.up : styles.down}>
                  {p.pnl >= 0n ? '+' : ''}{formatUnits(p.pnl, dec)}
                </span>
              </div>
            );
          })}
          <p className={styles.note}>
            Close a position from the Perps tab. The payout lands in your claimable balance here.
          </p>
        </div>
      )}
    </div>
  );
}
