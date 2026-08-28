import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccount } from '@gear-js/react-hooks';
import { useSails } from '../hooks/useSails';
import {
  useAmmPools,
  useLpPosition,
  useWalletBalances,
  useAllowances,
  useTokenSymbols,
} from '../hooks/useSpot';
import { useSpotActions } from '../hooks/useSpotActions';
import { AllowanceGate } from '../components/ui/AllowanceGate';
import { RiskBanner } from '../components/ui/RiskBanner';
import { EmptyState } from '../components/ui/EmptyState';
import { formatUnits, parseUnits, isValidDecimal, formatPrice } from '../lib/units';
import styles from './PoolsView.module.css';

/** Tolerances offered on deposits and swaps, in basis points. */
const SLIPPAGE_CHOICES = [50, 100, 300] as const;
const DEFAULT_SLIPPAGE_BPS = 50;

type Mode = 'add' | 'remove' | 'swap';

/**
 * Liquidity pools.
 *
 * The earning model is worth stating in the UI rather than leaving people to infer
 * it: fees are not a separate pot that accrues to a claimable balance, they are left
 * in the pool, so a share's redemption value grows. There is nothing to claim, and
 * withdrawing is how you realise them.
 */
export function PoolsView() {
  const { pools } = useAmmPools();
  const { program } = useSails();
  const { account } = useAccount();
  const actions = useSpotActions();

  const [poolId, setPoolId] = useState('');
  const pool = useMemo(
    () => pools.find((p) => String(p.id) === poolId) ?? pools.find((p) => p.active) ?? pools[0],
    [pools, poolId],
  );
  useEffect(() => {
    if (!poolId && pool) setPoolId(String(pool.id));
  }, [pool, poolId]);

  const tokenA = pool ? String(pool.token_a) : '';
  const tokenB = pool ? String(pool.token_b) : '';
  const decA = pool ? Number(pool.dec_a) : 0;
  const decB = pool ? Number(pool.dec_b) : 0;

  const tokens = useMemo(() => [tokenA, tokenB].filter(Boolean), [tokenA, tokenB]);
  const symbols = useTokenSymbols(tokens);
  const symA = symbols[tokenA] ?? 'A';
  const symB = symbols[tokenB] ?? 'B';
  const { balances, refresh: refreshBalances } = useWalletBalances(tokens);
  const { allowances, refresh: refreshAllowances } = useAllowances(tokens);
  const { position, refresh: refreshPosition } = useLpPosition(pool ? String(pool.id) : null);

  const [mode, setMode] = useState<Mode>('add');
  const [amountAStr, setAmountAStr] = useState('');
  const [amountBStr, setAmountBStr] = useState('');
  const [sharesStr, setSharesStr] = useState('');
  const [swapInStr, setSwapInStr] = useState('');
  const [swapFromA, setSwapFromA] = useState(true);
  const [slippageBps, setSlippageBps] = useState<number>(DEFAULT_SLIPPAGE_BPS);
  const [err, setErr] = useState<string | null>(null);

  const reserveA = pool ? BigInt(pool.reserve_a as any) : 0n;
  const reserveB = pool ? BigInt(pool.reserve_b as any) : 0n;
  const totalShares = pool ? BigInt(pool.total_shares as any) : 0n;
  const seeded = totalShares > 0n && reserveA > 0n && reserveB > 0n;

  const amountA = pool ? parseUnits(amountAStr, decA) : 0n;
  const amountB = pool ? parseUnits(amountBStr, decB) : 0n;
  const swapIn = pool ? parseUnits(swapInStr, swapFromA ? decA : decB) : 0n;

  // Mirror the second leg at the pool's current ratio, so a deposit is not silently
  // lopsided (the excess would be donated rather than minted for).
  const mirrorFromA = useCallback(
    (raw: bigint) => (seeded && raw > 0n ? (raw * reserveB) / reserveA : 0n),
    [seeded, reserveA, reserveB],
  );
  const onAmountA = (v: string) => {
    setAmountAStr(v);
    if (seeded && isValidDecimal(v)) {
      const mirrored = mirrorFromA(parseUnits(v, decA));
      setAmountBStr(mirrored > 0n ? formatUnits(mirrored, decB, Math.min(decB, 8)) : '');
    }
  };

  // Live swap quote straight from the contract, so the UI cannot disagree with it.
  const [quote, setQuote] = useState<{ out: bigint; fee: bigint }>({ out: 0n, fee: 0n });
  useEffect(() => {
    let live = true;
    if (!program || !pool || swapIn <= 0n) { setQuote({ out: 0n, fee: 0n }); return; }
    program.amm
      .quoteSwap(BigInt(pool.id as any), (swapFromA ? tokenA : tokenB) as `0x${string}`, swapIn)
      .call()
      .then(([out, fee]) => { if (live) setQuote({ out: BigInt(out), fee: BigInt(fee) }); })
      .catch(() => { if (live) setQuote({ out: 0n, fee: 0n }); });
    return () => { live = false; };
  }, [program, pool, swapIn, swapFromA, tokenA, tokenB]);

  const bound = (v: bigint) => (v * BigInt(10_000 - slippageBps)) / 10_000n;

  const escrowToken = mode === 'swap' ? (swapFromA ? tokenA : tokenB) : tokenA;
  const escrowNeeded = mode === 'swap' ? swapIn : amountA;
  const escrowDec = mode === 'swap' ? (swapFromA ? decA : decB) : decA;
  const escrowSym = mode === 'swap' ? (swapFromA ? symA : symB) : symA;

  const refreshAll = useCallback(() => {
    refreshBalances();
    refreshAllowances();
    refreshPosition();
  }, [refreshBalances, refreshAllowances, refreshPosition]);

  const submit = async () => {
    if (!pool) return;
    setErr(null);
    try {
      const id = BigInt(pool.id as any);
      if (mode === 'add') {
        if (amountA <= 0n || amountB <= 0n) throw new Error('Enter both amounts');
        // Expected shares at the current ratio, less tolerance.
        const expected = seeded
          ? (amountA * totalShares) / reserveA
          : 0n;
        await actions.addLiquidity(id, amountA, amountB, bound(expected));
        setAmountAStr(''); setAmountBStr('');
      } else if (mode === 'remove') {
        const shares = parseUnits(sharesStr, 0);
        if (shares <= 0n) throw new Error('Enter a share amount');
        if (shares > position.shares) throw new Error('More shares than you hold');
        const expA = (reserveA * shares) / (totalShares || 1n);
        const expB = (reserveB * shares) / (totalShares || 1n);
        await actions.removeLiquidity(id, shares, bound(expA), bound(expB));
        setSharesStr('');
      } else {
        if (swapIn <= 0n) throw new Error('Enter an amount');
        if (quote.out <= 0n) throw new Error('No quote available for that size');
        await actions.swap(id, swapFromA ? tokenA : tokenB, swapIn, bound(quote.out));
        setSwapInStr('');
      }
      refreshAll();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  if (pools.length === 0) {
    return (
      <div className={styles.wrap}>
        <RiskBanner />
        <EmptyState
          title="No liquidity pools yet"
          description="Pools are curated by the venue. Once one is listed you can supply both sides and earn a share of every swap fee."
        />
      </div>
    );
  }

  const priceAinB = seeded ? (reserveB * 10n ** BigInt(decA)) / reserveA : 0n;

  return (
    <div className={styles.wrap}>
      <RiskBanner />

      <div className={styles.panel}>
        <p className={styles.section}>Pool</p>
        <div className={styles.chips}>
          {pools.map((p) => {
            const a = symbols[String(p.token_a)] ?? 'A';
            const b = symbols[String(p.token_b)] ?? 'B';
            return (
              <button
                key={String(p.id)}
                type="button"
                className={`${styles.chip} ${String(p.id) === poolId ? styles.chipOn : ''}`}
                onClick={() => setPoolId(String(p.id))}
              >
                {a}/{b}{!p.active && ' (closed)'}
              </button>
            );
          })}
        </div>

        {pool && (
          <div className={styles.stats}>
            <div><span>Liquidity</span><b>{formatUnits(reserveA, decA, 4)} {symA}</b></div>
            <div><span></span><b>{formatUnits(reserveB, decB, 4)} {symB}</b></div>
            <div><span>Price</span><b>{seeded ? `${formatPrice(priceAinB, decB)} ${symB}/${symA}` : '—'}</b></div>
            <div><span>Fee</span><b>0.30%</b></div>
          </div>
        )}
      </div>

      {position.shares > 0n && (
        <div className={styles.panel}>
          <p className={styles.section}>Your position</p>
          <div className={styles.stats}>
            <div><span>Shares</span><b>{position.shares.toString()}</b></div>
            <div><span>Redeems for</span><b>{formatUnits(position.amountA, decA, 6)} {symA}</b></div>
            <div><span></span><b>{formatUnits(position.amountB, decB, 6)} {symB}</b></div>
          </div>
          <p className={styles.note}>
            Fees are not paid out separately. They stay in the pool, so what your shares redeem
            for grows as the pool trades. Withdraw to realise them.
          </p>
        </div>
      )}

      <div className={styles.panel}>
        <div className={styles.tabs} role="tablist">
          {(['add', 'remove', 'swap'] as Mode[]).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              className={`${styles.tab} ${mode === m ? styles.tabOn : ''}`}
              onClick={() => setMode(m)}
            >
              {m === 'add' ? 'Add liquidity' : m === 'remove' ? 'Withdraw' : 'Swap'}
            </button>
          ))}
        </div>

        {mode === 'add' && (
          <>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="pool-a">
                <span>{symA}</span>
                <span className={styles.hint}>Balance {formatUnits(balances[tokenA] ?? 0n, decA, 6)}</span>
              </label>
              <input
                id="pool-a" className={styles.input} inputMode="decimal" autoComplete="off"
                placeholder="0.00" value={amountAStr} onChange={(e) => onAmountA(e.target.value)}
                aria-invalid={amountAStr !== '' && !isValidDecimal(amountAStr)}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="pool-b">
                <span>{symB}</span>
                <span className={styles.hint}>Balance {formatUnits(balances[tokenB] ?? 0n, decB, 6)}</span>
              </label>
              <input
                id="pool-b" className={styles.input} inputMode="decimal" autoComplete="off"
                placeholder="0.00" value={amountBStr} onChange={(e) => setAmountBStr(e.target.value)}
                aria-invalid={amountBStr !== '' && !isValidDecimal(amountBStr)}
              />
              {seeded && (
                <p className={styles.hint}>
                  Matched to the pool's current ratio. Depositing out of ratio donates the excess
                  rather than minting shares for it.
                </p>
              )}
            </div>
          </>
        )}

        {mode === 'remove' && (
          <div className={styles.field}>
            <label className={styles.label} htmlFor="pool-shares">
              <span>Shares to withdraw</span>
              <span className={styles.hint}>You hold {position.shares.toString()}</span>
            </label>
            <input
              id="pool-shares" className={styles.input} inputMode="numeric" autoComplete="off"
              placeholder="0" value={sharesStr} onChange={(e) => setSharesStr(e.target.value)}
            />
            <div className={styles.chips}>
              {[25, 50, 75, 100].map((pct) => (
                <button
                  key={pct} type="button" className={styles.chip}
                  onClick={() => setSharesStr(((position.shares * BigInt(pct)) / 100n).toString())}
                >
                  {pct === 100 ? 'Max' : `${pct}%`}
                </button>
              ))}
            </div>
          </div>
        )}

        {mode === 'swap' && (
          <>
            <div className={styles.chips}>
              <button type="button" className={`${styles.chip} ${swapFromA ? styles.chipOn : ''}`}
                onClick={() => setSwapFromA(true)}>{symA} → {symB}</button>
              <button type="button" className={`${styles.chip} ${!swapFromA ? styles.chipOn : ''}`}
                onClick={() => setSwapFromA(false)}>{symB} → {symA}</button>
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="pool-swap">
                <span>Pay ({swapFromA ? symA : symB})</span>
                <span className={styles.hint}>
                  Balance {formatUnits(balances[swapFromA ? tokenA : tokenB] ?? 0n, swapFromA ? decA : decB, 6)}
                </span>
              </label>
              <input
                id="pool-swap" className={styles.input} inputMode="decimal" autoComplete="off"
                placeholder="0.00" value={swapInStr} onChange={(e) => setSwapInStr(e.target.value)}
                aria-invalid={swapInStr !== '' && !isValidDecimal(swapInStr)}
              />
            </div>
            {quote.out > 0n && (
              <div className={styles.total}>
                <span>You receive</span>
                <span>
                  {formatUnits(quote.out, swapFromA ? decB : decA, 6)} {swapFromA ? symB : symA}
                  <span className={styles.hint}>
                    {' '}· fee {formatUnits(quote.fee, swapFromA ? decA : decB, 6)} {swapFromA ? symA : symB}
                  </span>
                </span>
              </div>
            )}
          </>
        )}

        {/* Removing liquidity is bounded too: reserves move with every trade. */}
        <div className={styles.field}>
          <span className={styles.label}>
            <span>Max slippage</span>
            <span className={styles.hint}>Reverts if the result is worse</span>
          </span>
          <div className={styles.chips} role="group" aria-label="Max slippage">
            {SLIPPAGE_CHOICES.map((bps) => (
              <button
                key={bps} type="button" aria-pressed={slippageBps === bps}
                className={`${styles.chip} ${slippageBps === bps ? styles.chipOn : ''}`}
                onClick={() => setSlippageBps(bps)}
              >
                {bps / 100}%
              </button>
            ))}
          </div>
        </div>

        {!account ? (
          <p className={styles.empty}>Connect a wallet to provide liquidity.</p>
        ) : mode === 'remove' ? (
          <button className={styles.submit} disabled={actions.pending || position.shares === 0n} onClick={submit}>
            {actions.pending ? 'Withdrawing…' : 'Withdraw'}
          </button>
        ) : (
          <AllowanceGate
            allowance={allowances[escrowToken] ?? 0n}
            needed={escrowNeeded}
            symbol={escrowSym}
            amountLabel={`${formatUnits(escrowNeeded, escrowDec, Math.min(escrowDec, 6))} ${escrowSym}`}
            onApprove={(amt) => actions.approve(escrowToken, amt)}
            onApproved={refreshAllowances}
          >
            <button className={styles.submit} disabled={actions.pending} onClick={submit}>
              {actions.pending ? 'Submitting…' : mode === 'add' ? 'Add liquidity' : 'Swap'}
            </button>
          </AllowanceGate>
        )}
        {err && <p className={styles.err}>{err}</p>}

        {mode === 'add' && (
          <p className={styles.note}>
            Supplying liquidity earns you 0.3% of every swap, in proportion to your share of the
            pool. It also exposes you to impermanent loss: if the price moves, you can end up with
            less than if you had simply held the two tokens.
          </p>
        )}
      </div>
    </div>
  );
}
