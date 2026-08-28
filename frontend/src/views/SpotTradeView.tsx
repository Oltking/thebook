import { useEffect, useMemo, useState, useCallback } from 'react';
import { PairPicker } from '../components/ui/PairPicker';
import { AllowanceGate } from '../components/ui/AllowanceGate';
import { EmptyState } from '../components/ui/EmptyState';
import { useSpotPairs, useWalletBalances, useAllowances, useTokenSymbols } from '../hooks/useSpot';
import { useSpotActions } from '../hooks/useSpotActions';
import { useSails } from '../hooks/useSails';
import { useAccount } from '@gear-js/react-hooks';
import { useMarketData } from '../providers/MarketDataProvider';
import { useViewport } from '../hooks/useViewport';
import { TradeChart } from '../components/chart/TradeChart';
import { parseUnits, formatUnits, notional } from '../lib/units';
import { knownToken } from '../consts';
import styles from './SpotTradeView.module.css';

type Side = 'Buy' | 'Sell';
type OrderType = 'Limit' | 'Market';
type Level = [bigint, bigint];

const MAX_U128 = (1n << 128n) - 1n;

export function SpotTradeView() {
  const { pairs } = useSpotPairs();
  const { program } = useSails();
  const { account } = useAccount();
  const actions = useSpotActions();

  const [pairId, setPairId] = useState('');
  const pair = useMemo(
    () => pairs.find((p) => String(p.id) === pairId) ?? pairs.find((p) => p.active),
    [pairs, pairId],
  );

  // Default to the first active market once pairs load.
  useEffect(() => {
    if (!pairId && pair) setPairId(String(pair.id));
  }, [pair, pairId]);

  const base = pair ? String(pair.base) : '';
  const quote = pair ? String(pair.quote) : '';
  const baseDec = pair ? Number(pair.base_dec) : 0;
  const quoteDec = pair ? Number(pair.quote_dec) : 0;

  const symbols = useTokenSymbols([base, quote].filter(Boolean));
  const baseSym = symbols[base] ?? 'BASE';
  const quoteSym = symbols[quote] ?? 'QUOTE';

  const tokenList = useMemo(() => [base, quote].filter(Boolean), [base, quote]);
  const { balances, refresh: refreshBalances } = useWalletBalances(tokenList);
  const { allowances, refresh: refreshAllowances } = useAllowances(tokenList);

  // Order form.
  const [side, setSide] = useState<Side>('Buy');
  const [otype, setOtype] = useState<OrderType>('Limit');
  const [priceStr, setPriceStr] = useState('');
  const [qtyStr, setQtyStr] = useState('');
  const [maxSpendStr, setMaxSpendStr] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const priceRaw = pair ? parseUnits(priceStr, quoteDec) : 0n;
  const qtyRaw = pair ? parseUnits(qtyStr, baseDec) : 0n;
  const maxSpendRaw = pair ? parseUnits(maxSpendStr, quoteDec) : 0n;

  // Escrow token + amount the order needs approved.
  const escrowToken = side === 'Buy' ? quote : base;
  const escrowSym = side === 'Buy' ? quoteSym : baseSym;
  const needed = useMemo(() => {
    if (!pair) return 0n;
    if (side === 'Sell') return qtyRaw;
    return otype === 'Limit' ? notional(priceRaw, qtyRaw, baseDec) : maxSpendRaw;
  }, [pair, side, otype, priceRaw, qtyRaw, maxSpendRaw, baseDec]);

  const allowance = allowances[escrowToken] ?? 0n;
  const balance = balances[escrowToken] ?? 0n;
  const insufficient = needed > 0n && needed > balance;

  const refreshAll = useCallback(() => {
    refreshBalances();
    refreshAllowances();
  }, [refreshBalances, refreshAllowances]);

  // Live order book for this pair, shared by the chart (depth view) and the side panel.
  const [book, setBook] = useState<{ bids: Level[]; asks: Level[] }>({ bids: [], asks: [] });
  const refreshBook = useCallback(async () => {
    if (!program || !pair) return;
    try {
      const [bids, asks] = await program.spot.getOrderbook(BigInt(pair.id as any)).call();
      const toLevels = (rows: any[]): Level[] => rows.map((l) => [BigInt(l[0]), BigInt(l[1])]);
      setBook({ bids: toLevels(bids), asks: toLevels(asks) });
    } catch {
      /* transient read error; keep last */
    }
  }, [program, pair]);
  useEffect(() => {
    refreshBook();
    const iv = setInterval(() => { if (!document.hidden) refreshBook(); }, 5000);
    return () => clearInterval(iv);
  }, [refreshBook]);

  // Real market price + history for the base asset (WETH -> ETH, WVARA -> VARA). The
  // chart draws the underlying coin's real candles from Binance/CoinGecko, independent
  // of our on-chain liquidity; oraclePrice overlays the live spot price.
  const { prices, priceHistory } = useMarketData();
  // Resolve the price feed by token ADDRESS first (robust even when the on-chain
  // symbol read is slow/failing), then fall back to stripping the wrapped prefix.
  const chartAsset = useMemo(
    () => knownToken(base)?.priceKey ?? baseSym.replace(/^[wW]/, '').toUpperCase(),
    [base, baseSym],
  );
  const oraclePrice = useMemo(() => {
    const feed = prices[chartAsset as keyof typeof prices];
    return feed ? Number(feed.price_usd_micro) / 1_000_000 : 0;
  }, [prices, chartAsset]);

  // ── price reference (raw quote-units per whole base) used for % sizing, the
  //    market-price hint, and estimates. Prefer the entered limit price, then the
  //    book mid, then the real market price from the feed. ──
  const oracleRaw = useMemo(
    () => (oraclePrice > 0 ? BigInt(Math.round(oraclePrice * 10 ** quoteDec)) : 0n),
    [oraclePrice, quoteDec],
  );
  const bestBid = book.bids[0]?.[0] ?? 0n;
  const bestAsk = book.asks[0]?.[0] ?? 0n;
  const midRaw = bestBid > 0n && bestAsk > 0n ? (bestBid + bestAsk) / 2n : 0n;
  const effPrice =
    otype === 'Limit' && priceRaw > 0n ? priceRaw : midRaw > 0n ? midRaw : oracleRaw;

  // Price display precision: sub-cent assets (VARA ~$0.0004) need more decimals or
  // they round to 0.00. Capped at the quote token's own decimals.
  const priceFrac = useMemo(() => {
    const ref = oraclePrice > 0 ? oraclePrice : effPrice > 0n ? Number(effPrice) / 10 ** quoteDec : 0;
    const want = ref >= 1 ? 2 : ref >= 0.01 ? 4 : ref > 0 ? 6 : 2;
    return Math.min(want, quoteDec);
  }, [oraclePrice, effPrice, quoteDec]);

  const baseUnit = 10n ** BigInt(baseDec);
  const baseBal = balances[base] ?? 0n;
  const quoteBal = balances[quote] ?? 0n;

  // Set the amount / max-spend to `pct`% of the balance that funds this order:
  // selling spends base; buying spends quote (converted to base at effPrice).
  const applyPercent = useCallback(
    (pct: number) => {
      if (!pair) return;
      const p = BigInt(Math.max(0, Math.min(100, Math.round(pct))));
      const baseFrac = Math.min(baseDec, 8);
      const quoteFrac = Math.min(quoteDec, 6);
      if (side === 'Sell') {
        setQtyStr(formatUnits((baseBal * p) / 100n, baseDec, baseFrac));
      } else {
        const spend = (quoteBal * p) / 100n;
        if (otype === 'Market') setMaxSpendStr(formatUnits(spend, quoteDec, quoteFrac));
        if (effPrice > 0n) setQtyStr(formatUnits((spend * baseUnit) / effPrice, baseDec, baseFrac));
      }
    },
    [pair, side, otype, baseBal, quoteBal, baseDec, quoteDec, effPrice, baseUnit],
  );

  // Slider position derived from what's entered vs. the available balance.
  const currentPct = useMemo(() => {
    if (!pair) return 0;
    let used: bigint;
    let bal: bigint;
    if (side === 'Sell') { used = qtyRaw; bal = baseBal; }
    else { used = otype === 'Market' ? maxSpendRaw : notional(priceRaw, qtyRaw, baseDec); bal = quoteBal; }
    if (bal <= 0n) return 0;
    return Math.max(0, Math.min(100, Number((used * 100n) / bal)));
  }, [pair, side, otype, qtyRaw, maxSpendRaw, priceRaw, baseBal, quoteBal, baseDec]);

  // Estimated counter-amount, shown under the primary input.
  const estimate = useMemo(() => {
    if (!pair || effPrice <= 0n) return null;
    if (side === 'Buy' && otype === 'Market') {
      // spending maxSpend quote gets roughly this much base
      return maxSpendRaw > 0n
        ? `≈ ${formatUnits((maxSpendRaw * baseUnit) / effPrice, baseDec, 6)} ${baseSym}`
        : null;
    }
    // proceeds / cost in quote
    const q = notional(otype === 'Limit' ? priceRaw : effPrice, qtyRaw, baseDec);
    return q > 0n ? `≈ ${formatUnits(q, quoteDec, 4)} ${quoteSym}` : null;
  }, [pair, side, otype, effPrice, maxSpendRaw, priceRaw, qtyRaw, baseDec, quoteDec, baseUnit, baseSym, quoteSym]);

  // On phones the chart is collapsed behind a toggle so the order form leads; on
  // larger screens it always shows.
  const { isMobile } = useViewport();
  const [chartOpen, setChartOpen] = useState(false);
  const showChart = !isMobile || chartOpen;

  const submit = async () => {
    if (!pair) return;
    setErr(null);
    try {
      const id = BigInt(pair.id as any);
      if (otype === 'Limit') {
        if (priceRaw <= 0n || qtyRaw <= 0n) throw new Error('Enter a price and amount');
        await actions.placeLimit(id, side, priceRaw, qtyRaw);
      } else if (side === 'Buy') {
        if (maxSpendRaw <= 0n) throw new Error('Enter a max spend');
        // Derive the base qty ceiling from the budget at the reference price (with a
        // small buffer so max-spend is the true limiter); the contract still caps
        // spend at maxSpendRaw, so an over-estimate only means we spend a bit less.
        const buyQty =
          effPrice > 0n ? (maxSpendRaw * baseUnit * 102n) / (effPrice * 100n) : qtyRaw;
        if (buyQty <= 0n) throw new Error('Enter a max spend');
        await actions.marketBuy(id, buyQty, maxSpendRaw);
      } else {
        if (qtyRaw <= 0n) throw new Error('Enter an amount');
        await actions.marketSell(id, qtyRaw);
      }
      setQtyStr('');
      setMaxSpendStr('');
      refreshAll();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const canSubmit = !!pair && !!account && !insufficient && needed > 0n && !actions.pending;

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <PairPicker pairs={pairs} value={pairId} onChange={setPairId} className={styles.picker} />
        {pair && (
          <span className={styles.total}>
            {baseSym}/{quoteSym}
          </span>
        )}
      </div>

      {!pair ? (
        <div className={styles.panel} style={{ gridColumn: '1 / -1' }}>
          <EmptyState title="No markets yet" description="No trading pairs are listed on this exchange yet." />
        </div>
      ) : (
        <>
          <div className={styles.mainCol}>
          {isMobile && (
            <button
              className={styles.chartToggle}
              onClick={() => setChartOpen((v) => !v)}
              aria-expanded={chartOpen}
            >
              {chartOpen ? 'Hide chart ▴' : `Show ${chartAsset}/USD chart ▾`}
            </button>
          )}
          {showChart && (
            <div className={`${styles.panel} ${styles.chartPanel}`}>
              <TradeChart
                asset={chartAsset}
                oraclePrice={oraclePrice}
                priceHistory={priceHistory}
                bids={book.bids}
                asks={book.asks}
                trades={[]}
              />
            </div>
          )}
          <div className={styles.panel}>
            <div className={styles.sideRow}>
              <button
                className={`${styles.tab} ${styles.buy} ${side === 'Buy' ? styles.active : ''}`}
                onClick={() => setSide('Buy')}
              >
                Buy {baseSym}
              </button>
              <button
                className={`${styles.tab} ${styles.sell} ${side === 'Sell' ? styles.active : ''}`}
                onClick={() => setSide('Sell')}
              >
                Sell {baseSym}
              </button>
            </div>

            <div className={styles.typeRow}>
              {(['Limit', 'Market'] as OrderType[]).map((t) => (
                <button
                  key={t}
                  className={`${styles.tab} ${otype === t ? styles.active : ''}`}
                  onClick={() => setOtype(t)}
                >
                  {t}
                </button>
              ))}
            </div>

            {otype === 'Limit' && (
              <div className={styles.field}>
                <span className={styles.label}>
                  <span>Price</span>
                  <span className={styles.hint}>{quoteSym} per {baseSym}</span>
                </span>
                <input
                  className={styles.input}
                  inputMode="decimal"
                  placeholder={oracleRaw > 0n ? formatUnits(oracleRaw, quoteDec, priceFrac) : '0.00'}
                  value={priceStr}
                  onChange={(e) => setPriceStr(e.target.value)}
                />
                <div className={styles.chips}>
                  {bestBid > 0n && (
                    <button type="button" className={styles.chip} onClick={() => setPriceStr(formatUnits(bestBid, quoteDec, quoteDec))}>
                      Bid {formatUnits(bestBid, quoteDec, priceFrac)}
                    </button>
                  )}
                  {midRaw > 0n && (
                    <button type="button" className={styles.chip} onClick={() => setPriceStr(formatUnits(midRaw, quoteDec, quoteDec))}>
                      Mid {formatUnits(midRaw, quoteDec, priceFrac)}
                    </button>
                  )}
                  {bestAsk > 0n && (
                    <button type="button" className={styles.chip} onClick={() => setPriceStr(formatUnits(bestAsk, quoteDec, quoteDec))}>
                      Ask {formatUnits(bestAsk, quoteDec, priceFrac)}
                    </button>
                  )}
                  {midRaw === 0n && oracleRaw > 0n && (
                    <button type="button" className={styles.chip} onClick={() => setPriceStr(formatUnits(oracleRaw, quoteDec, priceFrac))}>
                      Market ≈ {formatUnits(oracleRaw, quoteDec, priceFrac)} {quoteSym}
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Primary size input: a quote budget for a market buy, else a base amount. */}
            {otype === 'Market' && side === 'Buy' ? (
              <div className={styles.field}>
                <span className={styles.label}>
                  <span>Max spend ({quoteSym})</span>
                  <span className={styles.hint}>Avail {formatUnits(quoteBal, quoteDec, 4)} {quoteSym}</span>
                </span>
                <input
                  className={styles.input}
                  inputMode="decimal"
                  placeholder="0.00"
                  value={maxSpendStr}
                  onChange={(e) => setMaxSpendStr(e.target.value)}
                />
              </div>
            ) : (
              <div className={styles.field}>
                <span className={styles.label}>
                  <span>Amount ({baseSym})</span>
                  <span className={styles.hint}>
                    {side === 'Buy'
                      ? `Avail ${formatUnits(quoteBal, quoteDec, 4)} ${quoteSym}`
                      : `Avail ${formatUnits(baseBal, baseDec, 6)} ${baseSym}`}
                  </span>
                </span>
                <input
                  className={styles.input}
                  inputMode="decimal"
                  placeholder="0.00"
                  value={qtyStr}
                  onChange={(e) => setQtyStr(e.target.value)}
                />
              </div>
            )}

            {/* Percentage-of-balance slider + quick chips. */}
            <div className={styles.sizer}>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={Math.round(currentPct)}
                onChange={(e) => applyPercent(Number(e.target.value))}
                className={`${styles.slider} ${side === 'Buy' ? styles.sliderBuy : styles.sliderSell}`}
                style={{ ['--pct' as never]: `${Math.round(currentPct)}%` }}
                aria-label="Percent of balance"
              />
              <div className={styles.chips}>
                {[25, 50, 75, 100].map((p) => (
                  <button
                    type="button"
                    key={p}
                    className={`${styles.chip} ${Math.round(currentPct) === p ? styles.chipOn : ''}`}
                    onClick={() => applyPercent(p)}
                  >
                    {p === 100 ? 'Max' : `${p}%`}
                  </button>
                ))}
              </div>
            </div>

            {estimate && (
              <div className={styles.total}>
                <span>{side === 'Buy' && otype === 'Limit' ? 'Total' : 'You get'}</span>
                <span>{estimate}</span>
              </div>
            )}

            {!account ? (
              <p className={styles.empty}>Connect a wallet to trade.</p>
            ) : insufficient ? (
              <button className={`${styles.submit} ${side === 'Buy' ? styles.buy : styles.sell}`} disabled>
                Insufficient {escrowSym}
              </button>
            ) : (
              <AllowanceGate
                allowance={allowance}
                needed={needed}
                symbol={escrowSym}
                onApprove={(amt) => actions.approve(escrowToken, side === 'Buy' ? MAX_U128 : amt)}
                onApproved={refreshAllowances}
              >
                <button
                  className={`${styles.submit} ${side === 'Buy' ? styles.buy : styles.sell}`}
                  disabled={!canSubmit}
                  onClick={submit}
                >
                  {actions.pending ? 'Submitting…' : `${side} ${baseSym}`}
                </button>
              </AllowanceGate>
            )}
            {err && <p className={styles.err}>{err}</p>}
          </div>
          </div>

          <SidePanel
            book={book}
            pairId={String(pair.id)}
            baseDec={baseDec}
            quoteDec={quoteDec}
            baseSym={baseSym}
            program={program}
            account={account}
            onCancelled={refreshAll}
          />
        </>
      )}
    </div>
  );
}

// The order book for the pair + the caller's open orders (with cancel).
function SidePanel({
  book,
  pairId,
  baseDec,
  quoteDec,
  baseSym,
  program,
  account,
  onCancelled,
}: {
  book: { bids: Level[]; asks: Level[] };
  pairId: string;
  baseDec: number;
  quoteDec: number;
  baseSym: string;
  program: ReturnType<typeof useSails>['program'];
  account: ReturnType<typeof useAccount>['account'];
  onCancelled: () => void;
}) {
  const actions = useSpotActions();
  const [orders, setOrders] = useState<SpotOrder[]>([]);

  const refresh = useCallback(async () => {
    if (!program || !account) return;
    try {
      const mine = await program.spot.getMyOrders().withAddress(account.decodedAddress).call();
      setOrders((Array.isArray(mine) ? mine : []).filter((o: SpotOrder) => String(o.pair_id) === pairId));
    } catch {
      /* transient read error; keep last */
    }
  }, [program, account, pairId]);

  useEffect(() => {
    refresh();
    const iv = setInterval(() => { if (!document.hidden) refresh(); }, 5000);
    return () => clearInterval(iv);
  }, [refresh]);

  const cancel = async (oid: bigint) => {
    try {
      await actions.cancelOrder(oid);
      onCancelled();
      refresh();
    } catch {
      /* surfaced elsewhere */
    }
  };

  const openOrders = orders.filter((o) => o.status === 'Open' || o.status === 'PartiallyFilled');

  return (
    <div className={styles.panel}>
      <div className={styles.section}>Order book</div>
      <div className={styles.book}>
        {book.asks.slice(0, 8).reverse().map(([p, q], i) => (
          <div key={`a${i}`} className={`${styles.level} ${styles.ask}`}>
            <span>{formatUnits(p, quoteDec)}</span>
            <span>{formatUnits(q, baseDec)}</span>
          </div>
        ))}
        <div className={styles.spread}>
          {book.asks[0] && book.bids[0]
            ? `spread ${formatUnits(book.asks[0][0] - book.bids[0][0], quoteDec)}`
            : '—'}
        </div>
        {book.bids.slice(0, 8).map(([p, q], i) => (
          <div key={`b${i}`} className={`${styles.level} ${styles.bid}`}>
            <span>{formatUnits(p, quoteDec)}</span>
            <span>{formatUnits(q, baseDec)}</span>
          </div>
        ))}
        {book.asks.length === 0 && book.bids.length === 0 && <div className={styles.empty}>Empty book</div>}
      </div>

      <div className={styles.section}>Your open orders</div>
      {openOrders.length === 0 ? (
        <div className={styles.empty}>No open orders</div>
      ) : (
        openOrders.map((o) => (
          <div key={String(o.id)} className={styles.order}>
            <span>
              {o.side} {formatUnits(BigInt(o.qty as any) - BigInt(o.filled as any), baseDec)} {baseSym} @{' '}
              {formatUnits(BigInt(o.price as any), quoteDec)}
            </span>
            <button className={styles.cancel} onClick={() => cancel(BigInt(o.id as any))} disabled={actions.pending}>
              Cancel
            </button>
          </div>
        ))
      )}
    </div>
  );
}
