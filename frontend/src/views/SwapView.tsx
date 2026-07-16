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
    if (!activePool || !inAmount) { setAmountOut(''); return; }
    const parsed = parseFloat(inAmount);
    if (isNaN(parsed) || parsed <= 0) { setAmountOut(''); return; }
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
  }, [activePool, fromAsset]);

  /* Keep the estimated output in sync with both assets, the amount, and live reserves */
  useEffect(() => { calculateOut(amountIn); }, [calculateOut, amountIn]);

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
          </div>

          <div className={styles.divider}>
            <div className={styles.arrowIcon}><ArrowDown size={20} /></div>
          </div>

          <div className={styles.inputGroup}>
            <div className={styles.inputHeader}>
              <span>To (Estimated)</span>
            </div>
            <div className={styles.inputRow}>
              <input type="number" placeholder="0.00" className={styles.amountInput} readOnly value={amountOut}
                aria-label="Estimated amount to receive" />
              <select value={toAsset} onChange={e => setToAsset(e.target.value as Asset)}
                className={styles.assetSelect} aria-label="To asset">
                {ALL_ASSETS.filter(a => a !== fromAsset).map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
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

          {activePool && (
            <div className={styles.priceInfo}>
              <div className={styles.infoRow}>
                <span>Pool Reserves</span>
                <span>{fmtUnits(activePool.reserve_a)} {activePool.asset_a} / {fmtUnits(activePool.reserve_b)} {activePool.asset_b}</span>
              </div>
            </div>
          )}
          {!activePool && pools.length > 0 && (
            <div className={styles.priceInfo}>
              <div className={styles.infoRow}>
                <span>No pool found for {fromAsset}/{toAsset}</span>
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
