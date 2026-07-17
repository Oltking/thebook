import { Card } from '../components/ui/Card';
import styles from './TradeView.module.css';
import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { usePortfolio } from '../hooks/usePortfolio';
import { usePerps } from '../hooks/usePerps';
import { useSails } from '../hooks/useSails';
import { TrendingUp, TrendingDown, BarChart3, BookOpen, ListOrdered, ShoppingCart, RefreshCw, Zap, Layers } from 'lucide-react';
import { useToast } from '../components/ui/Toast';
import { parseContractError } from '../lib/errors';
import { useViewport } from '../hooks/useViewport';
import { useTxStatus, TxStatusOverlay } from '../components/ui/TxStatus';
import { EmptyState } from '../components/ui/EmptyState';
import { useMarketData } from '../providers/MarketDataProvider';
import { TradeChart } from '../components/chart/TradeChart';
import { web3FromSource } from '@polkadot/extension-dapp';

type PanelId = 'chart' | 'depth' | 'executions' | 'entry' | 'positions';

const LEVERAGE_OPTIONS = [1, 2, 5, 10, 25];

function fmt(n: number, decimals = 2) {
  return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

interface TradeViewProps {
  mode?: 'spot' | 'futures';
}

export function TradeView({ mode = 'spot' }: TradeViewProps) {
  const [asset, setAsset]         = useState<Asset>('BTC');
  /* Futures defaults to Limit — market orders need the book seeded first */
  const [orderType, setOrderType] = useState<'Limit' | 'Market'>(mode === 'futures' ? 'Limit' : 'Market');
  const [direction, setDirection] = useState<'Long' | 'Short'>('Long');
  const [leverage, setLeverage]   = useState(1);
  const [usdAmount, setUsdAmount] = useState('');
  const [price, setPrice]         = useState('');
  const [mobilePanel, setMobilePanel] = useState<PanelId>('chart');
  const [myOrders, setMyOrders]   = useState<any[]>([]);
  const [cancellingOid, setCancellingOid] = useState<number | null>(null);
  const [demoLoading, setDemoLoading] = useState(false);
  const [side, setSide]           = useState<Side>('Buy');
  const [qty, setQty]             = useState('');
  const { isMobile } = useViewport();

  const isSpot    = mode === 'spot';
  const isFutures = mode === 'futures';

  const priceAutoRef = useRef(false);

  const { prices, orderbooks, trades, loading: marketLoading, pricesStalePer, pricesLoading, priceHistory, fetchPrice, refreshAll, tickMarket, tickLoading } = useMarketData();
  const { portfolio, refresh: refreshPortfolio } = usePortfolio();
  const { program, account } = useSails();
  /* Real on-chain perpetual positions + keeper mark prices */
  const { positions, marks: perpMarks, openPosition, closePosition, busy: perpBusy, refresh: refreshPerps } = usePerps();
  const { success, error } = useToast();
  const { txState, executeTx, resetTx } = useTxStatus();

  const orderbook  = orderbooks[asset] || { bids: [], asks: [] };
  const tradesList = trades[asset] || [];
  const oracleData = prices[asset];
  const offMark    = oracleData ? Number(oracleData.price_usd_micro) / 1_000_000 : 0;
  /* Futures settle at the on-chain keeper mark; fall back to the off-chain feed. */
  const markPrice  = isFutures && perpMarks[asset] > 0 ? perpMarks[asset] : offMark;
  const change24h  = oracleData ? Number(oracleData.change_24h_bps) / 100 : 0;
  const lastExecPrice = tradesList.length > 0 ? tradesList[0].price : 0n;

  useEffect(() => {
    priceAutoRef.current = false;
    if (markPrice > 0) { setPrice(markPrice.toFixed(2)); priceAutoRef.current = true; }
    else setPrice('');
  }, [asset]);

  useEffect(() => {
    if (markPrice > 0 && !priceAutoRef.current) {
      setPrice(markPrice.toFixed(2)); priceAutoRef.current = true;
    }
  }, [markPrice]);

  const entryPrice = useMemo(() => {
    if (orderType === 'Market') return markPrice;
    const p = parseFloat(price);
    return isNaN(p) || p <= 0 ? markPrice : p;
  }, [orderType, price, markPrice]);

  /* Actual USD to spend — what the contract deducts from balance */
  const actualCost = useMemo(() => {
    const a = parseFloat(usdAmount);
    return isNaN(a) || a <= 0 ? 0 : a;
  }, [usdAmount]);

  /* Leverage only scales how the position is labelled and the liq price — not the real cost */
  const displayNotional = actualCost * leverage;

  const assetQty = entryPrice > 0 ? actualCost / entryPrice : 0;

  const estimatedLiqPrice = useMemo(() => {
    if (!entryPrice || leverage <= 1) return 0;
    const m = 0.9 / leverage;
    return direction === 'Long' ? entryPrice * (1 - m) : entryPrice * (1 + m);
  }, [entryPrice, leverage, direction]);

  const spotAvailableBalance = useMemo(() => {
    if (!portfolio) return { value: 0n, label: '$0.00', decimals: 2 };
    if (side === 'Sell') {
      const amt = asset === 'BTC' ? portfolio.btc : asset === 'ETH' ? portfolio.eth : portfolio.vara;
      return { value: amt, label: `${(Number(amt)/1e5).toFixed(5)}`, decimals: 5 };
    }
    return { value: portfolio.usd, label: `$${(Number(portfolio.usd)/100).toLocaleString()}`, decimals: 2 };
  }, [portfolio, side, asset]);

  function minDecimals(n: number): number {
    if (n >= 1) return 3;
    if (n >= 0.01) return 4;
    return 5;
  }

  const applySpotPreset = (pct: number) => {
    if (!portfolio) return;
    const maxNumber = Number(spotAvailableBalance.value) / 10 ** spotAvailableBalance.decimals;
    const preset = (maxNumber * pct) / 100;
    if (side === 'Buy') {
      /* Buy balance is denominated in USD — convert to an asset quantity using
         the limit price (Limit) or the mark price (Market). qty is always asset units. */
      const px = orderType === 'Limit' ? parseFloat(price) : markPrice;
      if (!px || px <= 0) { error(orderType === 'Limit' ? 'Enter a price first' : 'Price unavailable — refresh and retry'); return; }
      /* Small buffer on market buys so book slippage doesn't trip InsufficientUsd */
      const usable = orderType === 'Market' ? preset * 0.98 : preset;
      const assetQty = usable / px;
      setQty(assetQty.toFixed(minDecimals(assetQty)));
    } else {
      /* Sell balance is already in asset units */
      setQty(preset.toFixed(minDecimals(preset)));
    }
  };

  const fetchMyOrders = useCallback(async () => {
    if (!program || !account) return;
    try {
      const result = await program.orderbook.getMyOrders().withAddress(account.decodedAddress).call();
      if (result && Array.isArray(result))
        setMyOrders(result.filter((o: any) => o[6] === 'Open' || o[6] === 'Partial'));
    } catch {}
  }, [program, account]);

  useEffect(() => { fetchMyOrders(); }, [fetchMyOrders, portfolio]);

  const handleCancelOrder = useCallback(async (oid: any) => {
    if (!program || !account || cancellingOid !== null) return;
    setCancellingOid(Number(oid));
    try {
      const { signer } = await web3FromSource(account.meta.source);
      const tx = program.orderbook.cancelOrder(oid);
      await tx.withAccount(account.address, { signer }).calculateGas(true, 100);
      const { response } = await tx.signAndSend();
      const result = await response();
      if (result && typeof result === 'object' && 'err' in result) {
        error(parseContractError(JSON.stringify((result as any).err)));
      } else {
        success('Order cancelled');
        setMyOrders(prev => prev.filter((o: any) => Number(o[0]) !== Number(oid)));
        refreshPortfolio(); refreshAll();
        setTimeout(() => { refreshPortfolio(); fetchMyOrders(); }, 2000);
      }
    } catch (e: any) { error(parseContractError(e?.message || String(e))); }
    finally { setCancellingOid(null); }
  }, [program, account, cancellingOid, error, success, refreshPortfolio, refreshAll, fetchMyOrders]);

  const handleClosePosition = useCallback(async (posAsset: Asset) => {
    if (!program || !account) return;
    const err = await closePosition(posAsset);
    if (err) { error(parseContractError(err)); return; }
    success('Position closed');
    refreshPortfolio(); refreshPerps();
    setTimeout(() => { refreshPortfolio(); refreshPerps(); }, 2500);
  }, [program, account, closePosition, refreshPortfolio, refreshPerps, success, error]);

  const handlePlaceOrder = async () => {
    if (!program || !account) return;
    if (pricesStalePer[asset] && !pricesLoading) await fetchPrice(asset);

    if (isSpot) {
      if (!qty) { error('Enter a quantity'); return; }
      const parsedQty = parseFloat(qty);
      if (isNaN(parsedQty) || parsedQty <= 0) { error('Invalid quantity'); return; }
      if (orderType === 'Limit') {
        const p = parseFloat(price);
        if (isNaN(p) || p <= 0) { error('Enter a valid price'); return; }
      }
      const q = BigInt(Math.round(parsedQty * 1e5));
      const err = await executeTx(
        () => orderType === 'Market'
          ? (side === 'Buy' ? program!.orderbook.marketBuy(asset, q) : program!.orderbook.marketSell(asset, q))
          : program!.orderbook.placeLimit(side, asset, BigInt(Math.max(1, Math.round(parseFloat(price)/1000))), q),
        account,
        () => {
          setQty('');
          refreshPortfolio(); refreshAll(); fetchMyOrders();
          success(`${side} order placed!`);
          setTimeout(() => { refreshPortfolio(); refreshAll(); fetchMyOrders(); }, 2500);
        }
      );
      if (err) error(parseContractError(err));
      return;
    }

    /* Futures: open a real on-chain perpetual position. Margin is the USD you post;
       the contract sizes it by leverage at the on-chain mark price. */
    if (actualCost <= 0) { error('Enter a margin amount'); return; }

    const availableUsd = portfolio ? Number(portfolio.usd) / 100 : 0;
    if (actualCost > availableUsd) {
      error(`Insufficient balance. You have $${fmt(availableUsd)} available.`);
      return;
    }
    if (markPrice <= 0) { error('No mark price yet — the keeper has not published one for this market.'); return; }

    const err = await openPosition(asset, direction === 'Long', actualCost, leverage);
    if (err) { error(parseContractError(err)); return; }
    setUsdAmount('');
    refreshPortfolio(); refreshPerps();
    success(`${direction} opened · ${leverage}x ${asset} · $${fmt(actualCost)} margin`);
    setTimeout(() => { refreshPortfolio(); refreshPerps(); }, 2500);
  };

  const executeDemoTrade = useCallback(async () => {
    if (!program || !account || !markPrice || demoLoading) return;
    setDemoLoading(true);
    try {
      const { signer } = await web3FromSource(account.meta.source);
      const demoAmt = asset === 'BTC' ? 0.001 : asset === 'ETH' ? 0.01 : 100;
      const q = BigInt(Math.round(demoAmt * 1e5));
      const p = BigInt(Math.max(1, Math.round(markPrice / 1000)));

      const st = program.orderbook.placeLimit('Sell', asset, p, q);
      await st.withAccount(account.address, { signer }).calculateGas(true, 100);
      const { response: sr } = await st.signAndSend();
      const sResult = await sr();
      if (sResult && typeof sResult === 'object' && 'err' in sResult) throw new Error(JSON.stringify((sResult as any).err));

      const bt = program.orderbook.placeLimit('Buy', asset, p, q);
      await bt.withAccount(account.address, { signer }).calculateGas(true, 100);
      const { response: br } = await bt.signAndSend();
      const bResult = await br();
      if (bResult && typeof bResult === 'object' && 'err' in bResult) throw new Error(JSON.stringify((bResult as any).err));

      success(`Demo execution: ${demoAmt} ${asset} @ $${fmt(markPrice)}`);
      refreshPortfolio(); refreshAll(); fetchMyOrders();
    } catch (e: any) { error(`Demo failed: ${parseContractError(e?.message || String(e))}`); }
    finally { setDemoLoading(false); }
  }, [program, account, markPrice, asset, demoLoading, success, error, refreshPortfolio, refreshAll, fetchMyOrders]);

  const maxQty = useMemo(() => {
    let m = 0n;
    for (const [, q] of [...orderbook.asks, ...orderbook.bids]) {
      const n = typeof q === 'bigint' ? q : BigInt(String(q));
      if (n > m) m = n;
    }
    return m;
  }, [orderbook]);

  const orderbookEmpty = orderbook.bids.length === 0 && orderbook.asks.length === 0;

  const fmtMark = (v: number) => v > 0 ? `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '---';

  const spotMobilePanels: { id: PanelId; label: string; icon: React.ElementType }[] = [
    { id: 'chart',      label: 'Chart',  icon: BarChart3 },
    { id: 'depth',      label: 'Depth',  icon: BookOpen },
    { id: 'executions', label: 'Trades', icon: ListOrdered },
    { id: 'entry',      label: 'Trade',  icon: ShoppingCart },
  ];

  const futuresMobilePanels: { id: PanelId; label: string; icon: React.ElementType }[] = [
    { id: 'chart',      label: 'Chart',      icon: BarChart3 },
    { id: 'depth',      label: 'Depth',      icon: BookOpen },
    { id: 'executions', label: 'Trades',     icon: ListOrdered },
    { id: 'entry',      label: 'Open',       icon: ShoppingCart },
    { id: 'positions',  label: 'Positions',  icon: Layers },
  ];

  const mobilePanels = isSpot ? spotMobilePanels : futuresMobilePanels;

  /* ────────────────── PANELS ────────────────── */

  const mobileChartHeader = (
    <div style={{ flexShrink: 0, borderBottom: '1px solid var(--border-color)', paddingBottom: 6, marginBottom: 4 }}>
      {/* Row 1: asset selector + refresh */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 5 }}>
        {(['BTC', 'ETH', 'VARA'] as Asset[]).map(a => (
          <button
            key={a}
            onClick={() => setAsset(a)}
            style={{
              flex: 1,
              padding: '3px 4px',
              borderRadius: 6,
              background: asset === a ? 'var(--primary)' : 'var(--card-bg-hover)',
              color: asset === a ? '#000' : 'var(--text-secondary)',
              fontWeight: 700,
              fontSize: 11,
              minHeight: 26,
              border: 'none',
              cursor: 'pointer',
            }}
          >
            {isSpot ? a : `${a}-P`}
          </button>
        ))}
        <button onClick={() => fetchPrice(asset)} disabled={pricesLoading}
          style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', padding: 0, minHeight: 26, cursor: 'pointer', flexShrink: 0 }}>
          <RefreshCw size={12} className={pricesLoading ? styles.spin : ''} />
        </button>
      </div>
      {/* Row 2: stats all in one horizontal line */}
      <div style={{ display: 'flex', flexDirection: 'row', gap: 8 }}>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
          <span style={{ fontSize: 7, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {isSpot ? 'Oracle' : 'Mark'}
          </span>
          <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', fontWeight: 700, color: change24h >= 0 ? 'var(--buy-green)' : 'var(--sell-red)', whiteSpace: 'nowrap' }}>
            {fmtMark(markPrice)}
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
          <span style={{ fontSize: 7, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>24h</span>
          <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', fontWeight: 700, color: change24h >= 0 ? 'var(--buy-green)' : 'var(--sell-red)', whiteSpace: 'nowrap' }}>
            {change24h >= 0 ? '+' : ''}{change24h.toFixed(2)}%
          </span>
        </div>
        {lastExecPrice > 0n && (
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
            <span style={{ fontSize: 7, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Fill</span>
            <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--text-main)', whiteSpace: 'nowrap' }}>
              ${fmt(Number(lastExecPrice) * 1000)}
            </span>
          </div>
        )}
      </div>
    </div>
  );

  const chartPanel = (
    <Card title={isSpot ? `${asset} / USD` : `${asset}-PERP`} className={styles.fullHeight}>
      {isMobile ? mobileChartHeader : (
        <div className={styles.headerStats}>
          <div className={styles.assetSelector}>
            {(['BTC', 'ETH', 'VARA'] as Asset[]).map(a => (
              <button key={a} className={asset === a ? styles.activeAsset : ''} onClick={() => setAsset(a)}>
                {isSpot ? a : `${a}-PERP`}
              </button>
            ))}
          </div>
          <div className={styles.marketStats}>
            <div className={styles.statItem}>
              <span className={styles.statLabel}>{isSpot ? 'Oracle Price' : 'Mark Price'}</span>
              <span className={`${styles.statValue} ${change24h >= 0 ? styles.positive : styles.negative}`}>
                {fmtMark(markPrice)}
              </span>
            </div>
            <div className={styles.statItem}>
              <span className={styles.statLabel}>24h Change</span>
              <span className={`${styles.statValue} ${change24h >= 0 ? styles.positive : styles.negative}`}>
                {change24h >= 0 ? '+' : ''}{change24h.toFixed(2)}%
              </span>
            </div>
            {lastExecPrice > 0n && (
              <div className={styles.statItem}>
                <span className={styles.statLabel}>Last Fill</span>
                <span className={styles.statValue}>${fmt(Number(lastExecPrice) * 1000)}</span>
              </div>
            )}
            <button className={styles.stalePriceBtn} onClick={() => fetchPrice(asset)} disabled={pricesLoading}
              title="Refresh mark price">
              <RefreshCw size={12} className={pricesLoading ? styles.spin : ''} />
            </button>
          </div>
        </div>
      )}
      <TradeChart trades={tradesList} oraclePrice={markPrice} priceHistory={priceHistory}
        bids={orderbook.bids} asks={orderbook.asks} asset={asset} />
    </Card>
  );

  const depthPanel = (
    <Card title="Order Depth" className={styles.fullHeight}>
      <div className={styles.obHeader}><span>Price</span><span>Size</span><span>Total</span></div>
      <div className={styles.obList}>
        {orderbookEmpty ? (
          <div className={styles.emptyBookWrap}>
            <EmptyState title={marketLoading ? 'Loading...' : 'Empty Book'}
              description={marketLoading ? '' : 'Place limit orders to seed the depth.'} />
            {!marketLoading && account && portfolio && (
              <div className={styles.seedActions}>
                {markPrice > 0 && (
                  <button className={styles.demoBtn} onClick={executeDemoTrade} disabled={demoLoading}>
                    <Zap size={13} />{demoLoading ? 'Executing...' : 'Quick Demo Execution'}
                  </button>
                )}
                <button className={styles.seedBtn} onClick={tickMarket} disabled={tickLoading}>
                  <RefreshCw size={13} className={tickLoading ? styles.spin : ''} />
                  {tickLoading ? 'Activating...' : 'Activate Market Maker'}
                </button>
              </div>
            )}
          </div>
        ) : (
          <>
            {orderbook.asks.slice(0, 10).reverse().map(([p, q], i) => (
              <div key={i} className={`${styles.obRow} ${styles.ask}`}
                style={{ '--depth': maxQty > 0n ? `${(Number(q) / Number(maxQty) * 100).toFixed(1)}%` : '0%' } as React.CSSProperties}
                onClick={() => { setPrice((Number(p) * 1000).toString()); priceAutoRef.current = false; }}
                role="button" tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPrice((Number(p)*1000).toString()); priceAutoRef.current = false; } }}>
                <span>{(Number(p)*1000).toLocaleString(undefined,{maximumFractionDigits:2})}</span>
                <span>{(Number(q)/1e5).toFixed(5)}</span>
                <span>{((Number(p)*Number(q))/100).toFixed(2)}</span>
              </div>
            ))}
            <div className={styles.spread}>
              <span className={styles.lastPrice}>{lastExecPrice ? (Number(lastExecPrice)*1000).toLocaleString(undefined,{maximumFractionDigits:2}) : '---'}</span>
              <span className={styles.spreadLabel}>Last Fill</span>
            </div>
            {orderbook.bids.slice(0, 10).map(([p, q], i) => (
              <div key={i} className={`${styles.obRow} ${styles.bid}`}
                style={{ '--depth': maxQty > 0n ? `${(Number(q) / Number(maxQty) * 100).toFixed(1)}%` : '0%' } as React.CSSProperties}
                onClick={() => { setPrice((Number(p)*1000).toString()); priceAutoRef.current = false; }}
                role="button" tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPrice((Number(p)*1000).toString()); priceAutoRef.current = false; } }}>
                <span>{(Number(p)*1000).toLocaleString(undefined,{maximumFractionDigits:2})}</span>
                <span>{(Number(q)/1e5).toFixed(5)}</span>
                <span>{((Number(p)*Number(q))/100).toFixed(2)}</span>
              </div>
            ))}
          </>
        )}
      </div>
    </Card>
  );

  const maxMargin = portfolio ? Number(portfolio.usd) / 100 : 0;

  const futuriesEntryPanel = (
    <Card title="Open Position">
      <div className={styles.directionBtns}>
        <button className={`${styles.longBtn} ${direction === 'Long' ? '' : styles.inactive}`}
          onClick={() => setDirection('Long')}>
          <TrendingUp size={15} /> Long
        </button>
        <button className={`${styles.shortBtn} ${direction === 'Short' ? '' : styles.inactive}`}
          onClick={() => setDirection('Short')}>
          <TrendingDown size={15} /> Short
        </button>
      </div>

      <div className={styles.orderTypeTabs}>
        <button className={orderType === 'Market' ? styles.activeType : ''} onClick={() => setOrderType('Market')}>Market</button>
        <button className={orderType === 'Limit' ? styles.activeType : ''} onClick={() => setOrderType('Limit')}>Limit</button>
      </div>

      <div className={styles.leverageRow}>
        <span className={styles.leverageLabel}>Leverage</span>
        <div className={styles.leverageBtns}>
          {LEVERAGE_OPTIONS.map(lev => (
            <button key={lev} className={`${styles.leverageBtn} ${leverage === lev ? styles.leverageActive : ''}`}
              onClick={() => setLeverage(lev)}>{lev}x</button>
          ))}
        </div>
      </div>

      {orderType === 'Limit' && (
        <div className={styles.formGroup}>
          <label>Entry Price (USD)</label>
          <input type="number" value={price}
            onChange={e => { setPrice(e.target.value); priceAutoRef.current = false; }} placeholder="0.00" />
          {markPrice > 0 && (
            <div className={styles.inputHint}
              onClick={() => { setPrice(markPrice.toFixed(2)); priceAutoRef.current = true; }}>
              Mark: {fmtMark(markPrice)}
            </div>
          )}
        </div>
      )}

      <div className={styles.formGroup}>
        <label>Margin (USD)</label>
        <input type="number" value={usdAmount} onChange={e => setUsdAmount(e.target.value)} placeholder="100" />
        {account && portfolio && maxMargin > 0 && (
          <div className={styles.balanceTag} onClick={() => setUsdAmount(maxMargin.toFixed(2))}>
            Available: ${fmt(maxMargin)}
          </div>
        )}
        {account && portfolio && maxMargin > 0 && (
          <div className={styles.presets}>
            {[25, 50, 75, 100].map(pct => (
              <button key={pct} className={styles.presetBtn}
                onClick={() => setUsdAmount(((maxMargin * pct) / 100).toFixed(2))}>{pct}%</button>
            ))}
          </div>
        )}
      </div>

      {actualCost > 0 && entryPrice > 0 && (
        <div className={styles.positionPreview}>
          <div className={styles.previewRow}>
            <span>USD Cost</span>
            <span className={styles.positive}>${fmt(actualCost)}</span>
          </div>
          <div className={styles.previewRow}>
            <span>Size</span>
            <span>{fmt(assetQty, 5)} {asset}</span>
          </div>
          {leverage > 1 && (
            <div className={styles.previewRow}>
              <span>Display Notional</span>
              <span>${fmt(displayNotional)}</span>
            </div>
          )}
          <div className={styles.previewRow}>
            <span>Mark Price</span>
            <span>{fmtMark(markPrice)}</span>
          </div>
          {estimatedLiqPrice > 0 && (
            <div className={styles.previewRow}>
              <span>Est. Liq. Price</span>
              <span className={styles.negative}>{fmtMark(estimatedLiqPrice)}</span>
            </div>
          )}
        </div>
      )}

      <button
        className={direction === 'Long' ? styles.submitLong : styles.submitShort}
        onClick={handlePlaceOrder}
        disabled={perpBusy}
      >
        {perpBusy ? 'Opening…' : `Open ${direction} ${leverage > 1 ? `${leverage}x ` : ''}${asset}`}
      </button>
      {!account && <div className={styles.connectWarn}>Connect wallet to trade</div>}

      {account && myOrders.length > 0 && (
        <div className={styles.myOrders}>
          <div className={styles.myOrdersHeader}>Pending Orders ({myOrders.length})</div>
          {myOrders.slice(0, 5).map((o: any, i: number) => (
            <div key={i} className={styles.myOrderRow}>
              <span className={o[1] === 'Buy' ? styles.buyText : styles.askText}>{String(o[1])} {String(o[2])}</span>
              <span className={styles.myOrderPrice}>${(Number(o[3])*1000).toLocaleString(undefined,{maximumFractionDigits:0})}</span>
              <span className={styles.myOrderQty}>{(Number(o[4])/1e5).toFixed(4)}</span>
              <button className={styles.cancelSmBtn} onClick={() => handleCancelOrder(o[0])}
                disabled={cancellingOid === Number(o[0])}>
                {cancellingOid === Number(o[0]) ? '…' : '✕'}
              </button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );

  const spotEntryPanel = (
    <Card title="Place Order">
      <div className={styles.spotSideButtons}>
        <button
          className={`${styles.spotBuyBtn} ${side === 'Buy' ? '' : styles.inactive}`}
          onClick={() => setSide('Buy')} aria-pressed={side === 'Buy'}>
          Buy
        </button>
        <button
          className={`${styles.spotSellBtn} ${side === 'Sell' ? '' : styles.inactive}`}
          onClick={() => setSide('Sell')} aria-pressed={side === 'Sell'}>
          Sell
        </button>
      </div>
      <div className={styles.orderTypeTabs}>
        <button className={orderType === 'Limit' ? styles.activeType : ''} onClick={() => setOrderType('Limit')}>Limit</button>
        <button className={orderType === 'Market' ? styles.activeType : ''} onClick={() => setOrderType('Market')}>Market</button>
      </div>
      {orderType === 'Limit' && (
        <div className={styles.formGroup}>
          <label>Price (USD)</label>
          <input type="number" value={price} onChange={e => { setPrice(e.target.value); priceAutoRef.current = false; }} placeholder="0.00" />
          {markPrice > 0 && (
            <div className={styles.inputHint} onClick={() => { setPrice(markPrice.toFixed(2)); priceAutoRef.current = true; }}>
              Mark: {fmtMark(markPrice)}
            </div>
          )}
        </div>
      )}
      <div className={styles.formGroup}>
        <label>Quantity ({asset})</label>
        <div className={styles.qtyRow}>
          <input type="number" value={qty} onChange={e => setQty(e.target.value)} placeholder="0.00" />
          {account && portfolio && (
            <div className={styles.balanceTag} onClick={() => applySpotPreset(100)}>
              Bal: {spotAvailableBalance.label}
            </div>
          )}
        </div>
        {account && portfolio && Number(spotAvailableBalance.value) > 0 && (
          <div className={styles.presets}>
            {[25, 50, 75, 100].map(pct => (
              <button key={pct} className={styles.presetBtn} onClick={() => applySpotPreset(pct)}>{pct}%</button>
            ))}
          </div>
        )}
      </div>
      {orderType === 'Limit' && (
        <div className={styles.totalInfo}>
          <span>Est. Total:</span>
          <span>${((parseFloat(price||'0')*parseFloat(qty||'0'))||0).toFixed(2)}</span>
        </div>
      )}
      <button
        className={side === 'Buy' ? styles.submitBuy : styles.submitSell}
        onClick={handlePlaceOrder}
        disabled={txState.visible && txState.stage !== 'failed' && txState.stage !== 'confirmed'}>
        {txState.stage === 'broadcasting' || txState.stage === 'confirming'
          ? 'Processing...'
          : orderType === 'Market' ? `Market ${side} ${asset}` : `${side} ${asset}`}
      </button>
      {!account && <div className={styles.connectWarn}>Connect wallet to trade</div>}
      {account && myOrders.length > 0 && (
        <div className={styles.myOrders}>
          <div className={styles.myOrdersHeader}>Open Orders ({myOrders.length})</div>
          {myOrders.slice(0, 5).map((o: any, i: number) => (
            <div key={i} className={styles.myOrderRow}>
              <span className={o[1]==='Buy' ? styles.buyText : styles.askText}>{String(o[1])} {String(o[2])}</span>
              <span className={styles.myOrderPrice}>${(Number(o[3])*1000).toLocaleString(undefined,{maximumFractionDigits:0})}</span>
              <span className={styles.myOrderQty}>{(Number(o[4])/1e5).toFixed(4)}</span>
              <button className={styles.cancelSmBtn} onClick={() => handleCancelOrder(o[0])} disabled={cancellingOid===Number(o[0])}>
                {cancellingOid===Number(o[0]) ? '…' : '✕'}
              </button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );

  const entryPanel = isSpot ? spotEntryPanel : futuriesEntryPanel;

  const positionsPanel = (
    <Card title="My Positions" className={styles.fullHeight}>
      {positions.length === 0 ? (
        <EmptyState title="No Open Positions" description="Open a Long or Short to see it here." />
      ) : (
        <div className={styles.positionsList}>
          {positions.map((pos, idx) => {
            const pnlPct = pos.margin > 0 ? (pos.pnl / pos.margin) * 100 : 0;
            const dir = pos.isLong ? 'Long' : 'Short';
            return (
              <div key={`${pos.asset}-${idx}`} className={styles.positionCard}>
                <div className={styles.positionHeader}>
                  <span className={pos.isLong ? styles.longTag : styles.shortTag}>
                    {pos.isLong ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                    {pos.asset} {dir} {pos.leverage > 1 ? `${pos.leverage}x` : ''}
                  </span>
                  <button className={styles.closePositionBtn}
                    onClick={() => handleClosePosition(pos.asset)}
                    disabled={perpBusy}>
                    Close
                  </button>
                </div>
                <div className={styles.positionGrid}>
                  <div><span className={styles.posLabel}>Entry</span><span>${fmt(pos.entry)}</span></div>
                  <div><span className={styles.posLabel}>Mark</span><span>{fmtMark(perpMarks[pos.asset] || markPrice)}</span></div>
                  <div><span className={styles.posLabel}>Liq.</span><span className={styles.negative}>{pos.liqPrice > 0 ? `$${fmt(pos.liqPrice)}` : '—'}</span></div>
                  <div><span className={styles.posLabel}>Size</span><span>{pos.size.toFixed(5)} {pos.asset}</span></div>
                  <div><span className={styles.posLabel}>Margin</span><span>${fmt(pos.margin)}</span></div>
                  <div><span className={styles.posLabel}>PnL</span>
                    <span className={pos.pnl >= 0 ? styles.positive : styles.negative}>
                      {pos.pnl >= 0 ? '+' : ''}${fmt(Math.abs(pos.pnl))} ({pos.pnl >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%)
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );

  const executionsPanel = (
    <Card title="Executions" className={styles.fullHeight}>
      <div className={styles.obHeader}><span>Price</span><span>Size</span><span>Time</span></div>
      <div className={styles.obList}>
        {tradesList.length === 0 && (
          <EmptyState title={marketLoading ? 'Loading...' : 'No Executions'}
            description={marketLoading ? '' : 'Filled orders appear here.'} />
        )}
        {tradesList.map((t, i) => (
          <div key={i} className={styles.obRow}>
            <span className={styles.buyText}>{(Number(t.price)*1000).toLocaleString(undefined,{maximumFractionDigits:2})}</span>
            <span>{(Number(t.qty)/1e5).toFixed(5)}</span>
            <span>{t.time}</span>
          </div>
        ))}
      </div>
    </Card>
  );

  if (isMobile) {
    return (
      <div className={styles.mobileContainer}>
        <div className={styles.mobileTabs}>
          {mobilePanels.map(p => {
            const Icon = p.icon;
            const hasBadge = p.id === 'positions' && positions.length > 0;
            return (
              <button key={p.id}
                className={`${styles.mobileTab} ${mobilePanel === p.id ? styles.mobileTabActive : ''}`}
                onClick={() => setMobilePanel(p.id)}>
                <Icon size={16} />
                <span>{p.label}</span>
                {hasBadge && <span className={styles.badge}>{positions.length}</span>}
              </button>
            );
          })}
        </div>
        <div className={`${styles.mobilePanel} ${mobilePanel !== 'entry' && mobilePanel !== 'positions' ? styles.mobilePanelFill : ''}`}>
          {mobilePanel === 'chart'      && chartPanel}
          {mobilePanel === 'depth'      && depthPanel}
          {mobilePanel === 'executions' && executionsPanel}
          {mobilePanel === 'entry'      && entryPanel}
          {mobilePanel === 'positions'  && isFutures && positionsPanel}
        </div>
        <TxStatusOverlay state={txState} onClose={resetTx} />
      </div>
    );
  }

  return (
    <div className={styles.grid}>
      {isFutures && (
        <div style={{
          gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 12px', marginBottom: 'var(--space-sm)', borderRadius: 8,
          fontSize: 12, fontWeight: 600,
          background: 'rgba(14,203,129,0.1)', border: '1px solid rgba(14,203,129,0.35)', color: 'var(--buy-green)',
        }}>
          ● Live perpetuals — isolated margin, settled on-chain at the keeper mark price. Positions can be liquidated at maintenance margin.
        </div>
      )}
      <div className={styles.chartArea}>{chartPanel}</div>
      <div className={styles.orderbookArea}>{depthPanel}</div>
      <div className={styles.entryArea}>
        {entryPanel}
        {isFutures && <div style={{ marginTop: 'var(--space-sm)' }}>{positionsPanel}</div>}
      </div>
      <div className={styles.tradesArea}>{executionsPanel}</div>
      <TxStatusOverlay state={txState} onClose={resetTx} />
    </div>
  );
}
