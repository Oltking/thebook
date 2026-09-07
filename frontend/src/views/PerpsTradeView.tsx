import { useMemo, useState } from 'react';
import { useAccount } from '@gear-js/react-hooks';
import { CandlestickChart } from 'lucide-react';
import { AllowanceGate } from '../components/ui/AllowanceGate';
import { EmptyState } from '../components/ui/EmptyState';
import { TradeChart } from '../components/chart/TradeChart';
import { useMarketData } from '../providers/MarketDataProvider';
import { usePerpMarkets, usePerpPositions, useWalletBalances, useAllowances, usePerpConfig } from '../hooks/useSpot';
import { useSpotActions } from '../hooks/useSpotActions';
import { parseUnits, formatUnits, formatPrice } from '../lib/units';
import { RiskBanner } from '../components/ui/RiskBanner';
import styles from './PerpsTradeView.module.css';

export function PerpsTradeView() {
  const { account } = useAccount();
  const { markets } = usePerpMarkets();
  const { positions, refresh: refreshPositions } = usePerpPositions();
  const actions = useSpotActions();
  const { config: perpConfig } = usePerpConfig();

  // Collateral is determined by the contract (set_collateral). Read from first market.
  const collateralAddr = useMemo(() => {
    const m = markets.find(m => m.active && !m.excluded);
    return m?.symbol ? null : '0x4255ff4a87a4c13dc39f74ace8c4948bbef2f75fb639d66639a1cfcc99e6243e';
  }, [markets]);
  
  const collateralList = useMemo(() => [collateralAddr ?? '0x4255ff4a87a4c13dc39f74ace8c4948bbef2f75fb639d66639a1cfcc99e6243e'], [collateralAddr]);
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
  const [chartOpen, setChartOpen] = useState(false);

  // Collateral decimals - default to 6 (wUSDT) but could be read from contract
  const collateralDec = 6; // wUSDT on Vara mainnet

  const marginRaw = parseUnits(marginStr, collateralDec);
  const notionalRaw = marginRaw * BigInt(leverage);
  const collateralAddrDynamic = collateralAddr ?? '0x4255ff4a87a4c13dc39f74ace8c4948bbef2f75fb639d66639a1cfcc99e6243e';
  const allowance = allowances[collateralAddrDynamic] ?? 0n;
  const balance = balances[collateralAddrDynamic] ?? 0n;
  const insufficient = marginRaw > 0n && marginRaw > balance;
  const mark = market ? BigInt(market.mark as any) : 0n;

  // The perp symbol is already the bare asset ("ETH", "VARA"), which is how the
  // price feed keys it. Strip a wrapped prefix defensively in case a market is ever
  // listed as wETH.
  const chartAsset = (market?.symbol ?? '').replace(/^[wW]/, '').toUpperCase();
  const { prices, priceHistory } = useMarketData();
  const oraclePrice = useMemo(() => {
    const feed = prices[chartAsset as keyof typeof prices];
    return feed ? Number(feed.price_usd_micro) / 1_000_000 : 0;
  }, [prices, chartAsset]);

  // Leverage options from perp config (default 5x)
  const maxLeverage = perpConfig?.maxLeverage ?? 5;
  const LEVERAGES = useMemo(() => Array.from({ length: maxLeverage }, (_, i) => i + 1), [maxLeverage]);

  // ── margin slider ──
  // Sizing by percentage of the wallet balance is the fast path most of the time,
  // so the slider drives the same `marginStr` the input does rather than holding a
  // second source of truth that could drift out of step with a typed amount.
  // Derived in basis points and rounded, NOT floored into whole percent. The margin
  // is itself a floored share of the balance, so flooring again here lands on p-1
  // for every percentage whose division leaves a remainder: the controlled input
  // would then render a step behind the thumb and fight the drag.
  const marginPct = balance > 0n
    ? Math.min(100, Math.round(Number((marginRaw * 10_000n) / balance) / 100))
    : 0;
  const setMarginPct = (pct: number) => {
    if (balance <= 0n) return;
    // Round-trips exactly: formatUnits at the token's own decimals is lossless, so
    // reparsing it yields the raw amount back.
    setMarginStr(pct <= 0 ? '' : formatUnits((balance * BigInt(pct)) / 100n, collateralDec));
  };

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
          <div className={styles.headRight}>
            <span className={styles.mark}>
              mark <b>{mark > 0n ? `$${formatPrice(mark, collateralDec)}` : '—'}</b>
            </span>
            <button
              type="button"
              className={`${styles.chartBtn} ${chartOpen ? styles.active : ''}`}
              onClick={() => setChartOpen((o) => !o)}
              aria-expanded={chartOpen}
              aria-label={chartOpen ? 'Hide chart' : `Show ${chartAsset}/USD chart`}
              title={chartOpen ? 'Hide chart' : `Show ${chartAsset}/USD chart`}
            >
              <CandlestickChart size={18} />
            </button>
          </div>
        )}
      </div>

      {market && chartOpen && (
        <div className={`${styles.panel} ${styles.chartPanel}`}>
          <TradeChart
            asset={chartAsset}
            oraclePrice={oraclePrice}
            priceHistory={priceHistory}
            bids={[]}
            asks={[]}
            trades={[]}
          />
        </div>
      )}

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
                <span>Margin (wUSDT)</span>
                <span>Balance: {formatUnits(balance, collateralDec)} wUSDT</span>
              </span>
              <input className={styles.input} inputMode="decimal" placeholder="0.00" value={marginStr} onChange={(e) => setMarginStr(e.target.value)} />

              <div className={styles.sizer}>
                <input
                  type="range"
                  className={styles.slider}
                  min={0}
                  max={100}
                  step={1}
                  value={marginPct}
                  disabled={balance <= 0n}
                  onChange={(e) => setMarginPct(Number(e.target.value))}
                  aria-label="Margin as a percentage of balance"
                />
                <div className={styles.pcts}>
                  {[25, 50, 75, 100].map((p) => (
                    <button
                      key={p}
                      type="button"
                      className={`${styles.pct} ${marginPct === p ? styles.active : ''}`}
                      disabled={balance <= 0n}
                      onClick={() => setMarginPct(p)}
                    >
                      {p === 100 ? 'Max' : `${p}%`}
                    </button>
                  ))}
                </div>
                {/* Sizing is a share of the balance, so with nothing to size the
                    control is inert. Say why rather than leaving a dead slider. */}
                {balance <= 0n && (
                  <p className={styles.sizerHint}>
                    {account
                      ? `Add wUSDT to this wallet to size a position.`
                      : `Connect a wallet holding wUSDT to size a position.`}
                  </p>
                )}
              </div>
            </div>

            <div className={styles.total}>
              <span>Position size</span>
              <span>{formatUnits(notionalRaw, collateralDec)} wUSDT</span>
            </div>

            {!account ? (
              <p className={styles.empty}>Connect a wallet to trade.</p>
            ) : insufficient ? (
              <button className={`${styles.submit} ${isLong ? styles.long : styles.short}`} disabled>Insufficient wUSDT</button>
            ) : mark === 0n ? (
              <button className={`${styles.submit} ${isLong ? styles.long : styles.short}`} disabled>Awaiting mark price</button>
            ) : (
              <AllowanceGate
                allowance={allowance}
                needed={marginRaw}
                symbol="wUSDT"
                onApprove={(amt) => actions.approve(collateralAddr ?? '0x4255ff4a87a4c13dc39f74ace8c4948bbef2f75fb639d66639a1cfcc99e6243e', amt)}
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
                    <span>size {formatUnits(p.notional, collateralDec)}</span>
                    <span>margin {formatUnits(p.margin, collateralDec)}</span>
                    <span className={p.pnl >= 0n ? styles.up : styles.down}>
                      pnl {p.pnl >= 0n ? '+' : '-'}{formatUnits(p.pnl < 0n ? -p.pnl : p.pnl, collateralDec)}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>

          <p className={styles.note}>Perpetual futures carry liquidation risk. Positions settle in wUSDT; proceeds appear in your Portfolio to withdraw.</p>
        </>
      )}
    </div>
  );
}
