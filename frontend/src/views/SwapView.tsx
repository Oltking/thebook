import { Card } from '../components/ui/Card';
import { ArrowDown } from 'lucide-react';
import styles from './SwapView.module.css';
import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useSails } from '../hooks/useSails';
import { useToast } from '../components/ui/Toast';
import { parseContractError } from '../lib/errors';
import { useTxStatus, TxStatusOverlay } from '../components/ui/TxStatus';
import { EmptyState } from '../components/ui/EmptyState';
import { useMarketData } from '../providers/MarketDataProvider';

export function SwapView() {
  const { program, account } = useSails();
  const { pools, prices, loading: marketLoading, pricesStale, pricesLoading, fetchPrices, refreshAll } = useMarketData();

  const priceUsd = (a: Asset) => {
    const f = prices[a];
    return f ? Number(f.price_usd_micro) / 1_000_000 : 0;
  };
  const fmtUnits = (raw: bigint | number | string) =>
    (Number(raw) / 1e5).toLocaleString(undefined, { maximumFractionDigits: 4 });
  const poolTvlUsd = (p: Pool) =>
    (Number(p.reserve_a) / 1e5) * priceUsd(p.asset_a) + (Number(p.reserve_b) / 1e5) * priceUsd(p.asset_b);
  const fmtUsd = (v: number) =>
    v > 0 ? `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '—';
  const [fromAsset, setFromAsset] = useState<Asset>('VARA');
  const [toAsset, setToAsset] = useState<Asset>('ETH');
  const [amountIn, setAmountIn] = useState('');
  const [amountOut, setAmountOut] = useState('');
  const [slippage, setSlippage] = useState(0.5);
  const { success, error } = useToast();
  const { txState, executeTx, resetTx } = useTxStatus();

  // The token pickers always offer every asset so they never render empty; whether
  // a route actually exists is handled separately by `activePool`.
  const ALL_ASSETS: Asset[] = ['BTC', 'ETH', 'VARA'];
  const availAssets = useMemo(
    () => [...new Set(pools.flatMap(p => [p.asset_a, p.asset_b]))],
    [pools]
  );

  const activePool = useMemo(
    () => pools.find(p =>
      (p.asset_a === fromAsset && p.asset_b === toAsset) ||
      (p.asset_a === toAsset && p.asset_b === fromAsset)
    ),
    [pools, fromAsset, toAsset]
  );

  const calculateOut = useCallback((inAmount: string) => {
    const parsed = parseFloat(inAmount);
    if (isNaN(parsed) || parsed <= 0) { setAmountOut(''); return; }

    if (activePool) {
      // Constant-product AMM quote off live pool reserves.
      const amount = BigInt(Math.round(parsed * 10**5));
      const fee = 997n;
      const feeDenom = 1000n;
      const reserveIn = BigInt((fromAsset === activePool.asset_a ? activePool.reserve_a : activePool.reserve_b).toString());
      const reserveOut = BigInt((fromAsset === activePool.asset_a ? activePool.reserve_b : activePool.reserve_a).toString());
      const amountInWithFee = amount * fee;
      const numerator = amountInWithFee * reserveOut;
      const denominator = reserveIn * feeDenom + amountInWithFee;
      const out = numerator / denominator;
      setAmountOut((Number(out) / 10**5).toFixed(5));
      return;
    }

    // No pool for this pair — show an indicative estimate from live spot prices so
    // the field always fills. (Executing still needs a pool; the button handles that.)
    const pf = priceUsd(fromAsset);
    const pt = priceUsd(toAsset);
    if (pf > 0 && pt > 0) {
      setAmountOut(((parsed * pf) / pt).toFixed(5));
    } else {
      setAmountOut('');
    }
  }, [activePool, fromAsset, toAsset, prices]);

  /* True when the estimate came from live spot prices (no AMM pool for the pair). */
  const spotEstimate = !activePool && amountOut !== '';

  /* Keep the estimated output in sync with both assets, the amount, and live reserves */
  useEffect(() => { calculateOut(amountIn); }, [calculateOut, amountIn]);

  /* First-class quote: rate, price impact, min received, LP fee — the trust
     surface an agent (or human) reads before confirming. */
  const quote = useMemo(() => {
    const pin = parseFloat(amountIn);
    const pout = parseFloat(amountOut);
    if (!activePool || isNaN(pin) || pin <= 0 || isNaN(pout) || pout <= 0) return null;
    const reserveIn = Number(fromAsset === activePool.asset_a ? activePool.reserve_a : activePool.reserve_b) / 1e5;
    const reserveOut = Number(fromAsset === activePool.asset_a ? activePool.reserve_b : activePool.reserve_a) / 1e5;
    const mid = reserveIn > 0 ? reserveOut / reserveIn : 0;      // spot out-per-in before trade
    const exec = pout / pin;                                     // realized out-per-in
    const impactPct = mid > 0 ? Math.max(0, (1 - exec / mid) * 100) : 0;
    return {
      rate: exec,
      impactPct,
      minReceived: pout * (1 - slippage / 100),
      fee: pin * 0.003,
    };
  }, [activePool, amountIn, amountOut, fromAsset, slippage]);

  const impactClass = quote
    ? quote.impactPct >= 5 ? styles.impactHigh : quote.impactPct >= 1 ? styles.impactMed : styles.impactLow
    : undefined;

  const usdHint = (amt: string, asset: Asset) => {
    const v = parseFloat(amt);
    return !isNaN(v) && v > 0 && priceUsd(asset) > 0 ? `≈ $${(v * priceUsd(asset)).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '';
  };

  /* Default to a real pool on first load, then keep the pair valid (never From == To) */
  const initRef = useRef(false);
  useEffect(() => {
    if (pools.length === 0) return;
    if (!initRef.current) {
      initRef.current = true;
      setFromAsset(pools[0].asset_a);
      setToAsset(pools[0].asset_b);
      return;
    }
    if (!availAssets.includes(fromAsset)) { setFromAsset(availAssets[0]); return; }
    if (toAsset === fromAsset || !availAssets.includes(toAsset)) {
      const other = availAssets.find(a => a !== fromAsset);
      if (other) setToAsset(other);
    }
  }, [pools, availAssets, fromAsset, toAsset]);

  const handleSwap = async () => {
    if (!program || !account || !activePool || !amountIn) return;
    if (pricesStale && !pricesLoading) {
      success('Price is stale — signing a refresh tx now. Please approve in your wallet.');
      await fetchPrices();
    }
    const parsedIn = parseFloat(amountIn);
    const parsedOut = parseFloat(amountOut);
    if (isNaN(parsedIn) || parsedIn <= 0) return;
    const slippageMultiplier = (100 - slippage) / 100;
    const minOutValue = isNaN(parsedOut) || parsedOut <= 0 ? 0n : BigInt(Math.round(parsedOut * 10**5 * slippageMultiplier));
    const inAmount = BigInt(Math.round(parsedIn * 10**5));
    const minOut = minOutValue;

    const err = await executeTx(
      () => program!.amm.swap(activePool.id, fromAsset as Asset, inAmount, minOut),
      account,
      () => {
        setAmountIn('');
        setAmountOut('');
        refreshAll();
        success('Swap executed!');
        setTimeout(() => refreshAll(), 2000);
      }
    );

    if (err) {
      error(parseContractError(err));
    }
  };

  return (
    <>
      <div className={styles.container}>
        <Card title="Swap Tokens" className={styles.swapCard}>
          <div className={styles.inputGroup}>
            <div className={styles.inputHeader}>
              <span>From</span>
            </div>
            <div className={styles.inputRow}>
              <input type="number" placeholder="0.00" className={styles.amountInput}
                value={amountIn} onChange={e => setAmountIn(e.target.value)}
                aria-label="Amount to swap from" />
              <select value={fromAsset} onChange={e => setFromAsset(e.target.value as Asset)}
                className={styles.assetSelect} aria-label="From asset">
                {ALL_ASSETS.filter(a => a !== toAsset).map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
            {usdHint(amountIn, fromAsset) && <div className={styles.usdHint}>{usdHint(amountIn, fromAsset)}</div>}
          </div>

          <div className={styles.divider}>
            <div className={styles.arrowIcon}><ArrowDown size={20} /></div>
          </div>

          <div className={styles.inputGroup}>
            <div className={styles.inputHeader}>
              <span>{spotEstimate ? 'To (Estimated · spot)' : 'To (Estimated)'}</span>
            </div>
            <div className={styles.inputRow}>
              <input type="number" placeholder="0.00" className={styles.amountInput} readOnly value={amountOut}
                aria-label="Estimated amount to receive" />
              <select value={toAsset} onChange={e => setToAsset(e.target.value as Asset)}
                className={styles.assetSelect} aria-label="To asset">
                {ALL_ASSETS.filter(a => a !== fromAsset).map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
            {usdHint(amountOut, toAsset) && <div className={styles.usdHint}>{usdHint(amountOut, toAsset)}</div>}
          </div>

          <div className={styles.slippageRow}>
            <span>Slippage Tolerance</span>
            <div className={styles.slippageOptions}>
              {[0.1, 0.5, 1.0].map(s => (
                <button key={s}
                  className={`${styles.slippageBtn} ${slippage === s ? styles.slippageActive : ''}`}
                  onClick={() => setSlippage(s)}>
                  {s}%
                </button>
              ))}
              <input type="number" value={slippage} onChange={e => setSlippage(parseFloat(e.target.value) || 0.5)}
                className={styles.slippageInput} min={0.01} max={50} step={0.1}
                aria-label="Custom slippage percentage" />
            </div>
          </div>

          {quote && activePool && (
            <div className={styles.priceInfo}>
              <div className={styles.infoRow}>
                <span>Rate</span>
                <span>1 {fromAsset} = {quote.rate.toLocaleString(undefined, { maximumFractionDigits: 6 })} {toAsset}</span>
              </div>
              <div className={styles.infoRow}>
                <span>Price impact</span>
                <span className={impactClass}>{quote.impactPct < 0.01 ? '<0.01' : quote.impactPct.toFixed(2)}%</span>
              </div>
              <div className={styles.infoRow}>
                <span>Min. received ({slippage}% slip)</span>
                <span>{quote.minReceived.toLocaleString(undefined, { maximumFractionDigits: 5 })} {toAsset}</span>
              </div>
              <div className={styles.infoRow}>
                <span>LP fee (0.3%)</span>
                <span>{quote.fee.toLocaleString(undefined, { maximumFractionDigits: 6 })} {fromAsset}</span>
              </div>
            </div>
          )}
          {!quote && activePool && (
            <div className={styles.priceInfo}>
              <div className={styles.infoRow}>
                <span>Pool reserves</span>
                <span>{fmtUnits(activePool.reserve_a)} {activePool.asset_a} / {fmtUnits(activePool.reserve_b)} {activePool.asset_b}</span>
              </div>
            </div>
          )}
          {spotEstimate && (
            <div className={styles.priceInfo}>
              <div className={styles.infoRow}>
                <span>Indicative rate (spot)</span>
                <span>1 {fromAsset} = {(priceUsd(fromAsset) / (priceUsd(toAsset) || 1)).toLocaleString(undefined, { maximumFractionDigits: 6 })} {toAsset}</span>
              </div>
              <div className={styles.infoRow}>
                <span style={{ color: 'var(--text-dim)' }}>No {fromAsset}/{toAsset} pool yet — create one on Pools to swap.</span>
              </div>
            </div>
          )}

          <button className={styles.swapBtn} onClick={handleSwap}
            disabled={txState.visible && txState.stage !== 'failed' && txState.stage !== 'confirmed' || !account || !activePool}>
            {txState.stage === 'broadcasting' || txState.stage === 'confirming' ? 'Swapping...' : 'Swap'}
          </button>
          {!account && <div style={{ textAlign: 'center', marginTop: 8, color: 'var(--text-secondary)' }}>Connect wallet to swap</div>}
        </Card>

        <div className={styles.details}>
          <Card title="Available Pools">
            {pools.length === 0 && (
              <EmptyState
                title={marketLoading ? 'Loading...' : 'No Pools Found'}
                description={marketLoading ? 'Fetching pool data...' : 'Visit the Pools page to create the first liquidity pool.'}
              />
            )}
            {pools.map(p => (
              <div key={p.id.toString()} className={styles.infoRow} style={{ padding: '8px 16px' }}>
                <span>{p.asset_a} / {p.asset_b}</span>
                <span>TVL: {fmtUsd(poolTvlUsd(p))}</span>
              </div>
            ))}
          </Card>
        </div>
      </div>

      <TxStatusOverlay state={txState} onClose={resetTx} />
    </>
  );
}
