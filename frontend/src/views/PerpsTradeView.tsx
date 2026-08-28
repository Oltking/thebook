import { useMemo, useState } from 'react';
import { useAccount } from '@gear-js/react-hooks';
import { AllowanceGate } from '../components/ui/AllowanceGate';
import { EmptyState } from '../components/ui/EmptyState';
import { usePerpMarkets, usePerpPositions, useWalletBalances, useAllowances } from '../hooks/useSpot';
import { useSpotActions } from '../hooks/useSpotActions';
import { parseUnits, formatUnits } from '../lib/units';
import { RiskBanner } from '../components/ui/RiskBanner';
import styles from './PerpsTradeView.module.css';

// Perps settle in wUSDT (6 decimals) on Vara mainnet.
const COLLATERAL = { addr: '0x4255ff4a87a4c13dc39f74ace8c4948bbef2f75fb639d66639a1cfcc99e6243e', dec: 6, sym: 'wUSDT' };
// Capped at the contract's MAX_LEVERAGE (5x). Offering a level the contract will
// reject just produces a failed transaction the user pays gas for.
const LEVERAGES = [1, 2, 3, 4, 5];
// Marks are published in pico-USD ($1 = 1e12). Micro-USD left sub-cent assets like
// VARA with three significant figures; see scripts/perps-keeper.mjs.
const MARK_DEC = 12;

export function PerpsTradeView() {
  const { account } = useAccount();
  const { markets } = usePerpMarkets();
  const { positions, refresh: refreshPositions } = usePerpPositions();
  const actions = useSpotActions();

  const collateralList = useMemo(() => [COLLATERAL.addr], []);
  const { balances, refresh: refreshBal } = useWalletBalances(collateralList);
  const { allowances, refresh: refreshAllow } = useAllowances(collateralList);

  // Only markets that are actually enabled and named; the contract can hold empty
  // reserved slots (blank symbol / inactive) that must not render as "-PERP".
  const liveMarkets = useMemo(
    () => markets.filter((m) => m.active && typeof m.symbol === 'string' && m.symbol.trim() !== ''),
    [markets],
  );

  const [marketId, setMarketId] = useState('0');
  const market = markets.find((m) => String(m.id) === marketId) ?? liveMarkets[0];
  const [isLong, setIsLong] = useState(true);
  const [leverage, setLeverage] = useState(2);
  const [marginStr, setMarginStr] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const marginRaw = parseUnits(marginStr, COLLATERAL.dec);
  const notionalRaw = marginRaw * BigInt(leverage);
  const allowance = allowances[COLLATERAL.addr] ?? 0n;
  const balance = balances[COLLATERAL.addr] ?? 0n;
  const insufficient = marginRaw > 0n && marginRaw > balance;
  const mark = market ? BigInt(market.mark as any) : 0n;

  const symOf = (id: bigint | string) => markets.find((m) => String(m.id) === String(id))?.symbol ?? `#${id}`;

  const open = async () => {
    if (!market) return;
    setErr(null);
    try {
      if (marginRaw <= 0n) throw new Error('Enter a margin amount');
      await actions.openPosition(BigInt(market.id as any), isLong, marginRaw, leverage);
      setMarginStr('');
      refreshBal(); refreshPositions();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const close = async (id: bigint) => {
    try { await actions.closePosition(id); refreshPositions(); refreshBal(); } catch { /* ignore */ }
  };

  const canOpen = !!account && !!market && marginRaw > 0n && !insufficient && mark > 0n && !actions.pending;

  return (
    <div className={styles.wrap}>
      <RiskBanner variant="perps" />
      <div className={styles.head}>
        <div className={styles.mkt}>
          {liveMarkets.map((m) => (
            <button
              key={String(m.id)}
              className={`${styles.mktBtn} ${String(m.id) === String(market?.id) ? styles.active : ''}`}
              onClick={() => setMarketId(String(m.id))}
            >
              {m.symbol}-PERP
            </button>
          ))}
        </div>
        {market && (
          <span className={styles.mark}>
            mark <b>{mark > 0n ? `$${formatUnits(mark, MARK_DEC, 2)}` : '—'}</b>
          </span>
        )}
      </div>

      {liveMarkets.length === 0 ? (
        <div className={styles.panel} style={{ gridColumn: '1 / -1' }}>
          <EmptyState title="Perps not live yet" description="No perpetual markets are enabled on this exchange yet." />
        </div>
      ) : (
        <>
          <div className={styles.panel}>
            <div className={styles.sideRow}>
              <button className={`${styles.tab} ${styles.long} ${isLong ? styles.active : ''}`} onClick={() => setIsLong(true)}>Long</button>
              <button className={`${styles.tab} ${styles.short} ${!isLong ? styles.active : ''}`} onClick={() => setIsLong(false)}>Short</button>
            </div>

            <div className={styles.field}>
              <span className={styles.label}>Leverage</span>
              <div className={styles.levs}>
                {LEVERAGES.map((l) => (
                  <button key={l} className={`${styles.lev} ${leverage === l ? styles.active : ''}`} onClick={() => setLeverage(l)}>{l}x</button>
                ))}
              </div>
            </div>

            <div className={styles.field}>
              <span className={styles.label}>
                <span>Margin ({COLLATERAL.sym})</span>
                <span>Balance: {formatUnits(balance, COLLATERAL.dec)} {COLLATERAL.sym}</span>
              </span>
              <input className={styles.input} inputMode="decimal" placeholder="0.00" value={marginStr} onChange={(e) => setMarginStr(e.target.value)} />
            </div>

            <div className={styles.total}>
              <span>Position size</span>
              <span>{formatUnits(notionalRaw, COLLATERAL.dec)} {COLLATERAL.sym}</span>
            </div>

            {!account ? (
              <p className={styles.empty}>Connect a wallet to trade.</p>
            ) : insufficient ? (
              <button className={`${styles.submit} ${isLong ? styles.long : styles.short}`} disabled>Insufficient {COLLATERAL.sym}</button>
            ) : mark === 0n ? (
              <button className={`${styles.submit} ${isLong ? styles.long : styles.short}`} disabled>Awaiting mark price</button>
            ) : (
              <AllowanceGate
                allowance={allowance}
                needed={marginRaw}
                symbol={COLLATERAL.sym}
                onApprove={(amt) => actions.approve(COLLATERAL.addr, amt)}
                onApproved={refreshAllow}
              >
                <button className={`${styles.submit} ${isLong ? styles.long : styles.short}`} disabled={!canOpen} onClick={open}>
                  {actions.pending ? 'Submitting…' : `${isLong ? 'Long' : 'Short'} ${market?.symbol}`}
                </button>
              </AllowanceGate>
            )}
            {err && <p className={styles.err}>{err}</p>}
          </div>

          <div className={styles.panel}>
            <div className={styles.section}>Your positions</div>
            {positions.length === 0 ? (
              <div className={styles.empty}>No open positions</div>
            ) : (
              positions.map((p) => (
                <div key={String(p.id)} className={styles.pos}>
                  <div className={styles.posTop}>
                    <span><strong>{symOf(p.marketId)}</strong> {p.isLong ? 'Long' : 'Short'} {p.leverage}x</span>
                    <button className={styles.close} onClick={() => close(p.id)} disabled={actions.pending}>Close</button>
                  </div>
                  <div className={styles.meta}>
                    <span>size {formatUnits(p.notional, COLLATERAL.dec)}</span>
                    <span>margin {formatUnits(p.margin, COLLATERAL.dec)}</span>
                    <span className={p.pnl >= 0n ? styles.up : styles.down}>
                      pnl {p.pnl >= 0n ? '+' : '-'}{formatUnits(p.pnl < 0n ? -p.pnl : p.pnl, COLLATERAL.dec)}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>

          <p className={styles.note}>Perpetual futures carry liquidation risk. Positions settle in {COLLATERAL.sym}; proceeds appear in your Portfolio to withdraw.</p>
        </>
      )}
    </div>
  );
}
