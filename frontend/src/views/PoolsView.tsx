import { Card } from '../components/ui/Card';
import styles from './PoolsView.module.css';
import { useState, useEffect, useRef } from 'react';
import { useSails } from '../hooks/useSails';
import { useToast } from '../components/ui/Toast';
import { parseContractError } from '../lib/errors';
import { useViewport } from '../hooks/useViewport';
import { useTxStatus, TxStatusOverlay } from '../components/ui/TxStatus';
import { EmptyState } from '../components/ui/EmptyState';
import { useMarketData } from '../providers/MarketDataProvider';
import { usePortfolio } from '../hooks/usePortfolio';
import { web3FromSource } from '@polkadot/extension-dapp';

type ModalMode = 'add' | 'remove';

interface ManagedPool {
  pool: Pool;
  myLp: number;
}

export function PoolsView() {
  const { program, account, isReady } = useSails();
  const { pools, prices, orderbooks, loading: marketLoading, refreshAll } = useMarketData();
  const { portfolio, refresh: refreshPortfolio } = usePortfolio();
  const [myLp, setMyLp] = useState<any[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [newA, setNewA] = useState<Asset>('BTC');
  const [newB, setNewB] = useState<Asset>('ETH');
  const { success, error } = useToast();
  const { isMobile } = useViewport();
  const { txState, executeTx, resetTx } = useTxStatus();
  const mountedRef = useRef(true);

  /* Manage modal state */
  const [managed, setManaged] = useState<ManagedPool | null>(null);
  const [modalMode, setModalMode] = useState<ModalMode>('add');
  const [amountA, setAmountA] = useState('');
  const [amountB, setAmountB] = useState('');
  const [lpAmount, setLpAmount] = useState('');

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!program || !account || !isReady) return;
    Promise.allSettled(pools.map(p =>
      program.amm.getLpPosition(p.id, account.decodedAddress).call()
        .then(pos => pos ? { ...pos, pool: p } as any : null)
    )).then(results => {
      if (mountedRef.current) {
        setMyLp(results
          .filter(r => r.status === 'fulfilled')
          .map(r => (r as PromiseFulfilledResult<any>).value)
          .filter(Boolean));
      }
    });
  }, [program, account, isReady, pools]);

  const handleCreatePool = async () => {
    if (!program || !account) return;
    if (newA === newB) { error('Cannot create a pool with the same asset.'); return; }
    const err = await executeTx(
      () => program!.amm.createPool(newA, newB),
      account,
      () => { success('Pool created!'); setShowCreate(false); refreshAll(); setTimeout(() => refreshAll(), 2000); }
    );
    if (err) error(parseContractError(err));
  };

  const openManage = (pool: Pool) => {
    const lpPos = myLp.find((p: any) => Number(p.pool_id) === Number(pool.id));
    setManaged({ pool, myLp: lpPos ? Number(lpPos.amount) : 0 });
    setModalMode('add');
    setAmountA('');
    setAmountB('');
    setLpAmount('');
  };

  const closeModal = () => { setManaged(null); resetTx(); };

  const handleAddLiquidity = async () => {
    if (!program || !account || !managed) return;
    const a = parseFloat(amountA);
    const b = parseFloat(amountB);
    if (isNaN(a) || a <= 0 || isNaN(b) || b <= 0) { error('Enter valid amounts'); return; }
    const poolId = managed.pool.id;
    const bigA = BigInt(Math.round(a * 10**5));
    const bigB = BigInt(Math.round(b * 10**5));
    const err = await executeTx(
      () => program!.amm.addLiquidity(poolId, bigA, bigB),
      account,
      () => { success('Liquidity added!'); closeModal(); refreshAll(); setTimeout(() => refreshAll(), 2000); }
    );
    if (err) error(parseContractError(err));
  };

  const handleRemoveLiquidity = async () => {
    if (!program || !account || !managed) return;
    const lp = parseFloat(lpAmount);
    if (isNaN(lp) || lp <= 0) { error('Enter a valid LP amount'); return; }
    const poolId = managed.pool.id;
    const bigLp = BigInt(Math.round(lp * 10**5));
    const err = await executeTx(
      () => program!.amm.removeLiquidity(poolId, bigLp),
      account,
      () => { success('Liquidity removed!'); closeModal(); refreshAll(); setTimeout(() => refreshAll(), 2000); }
    );
    if (err) error(parseContractError(err));
  };

  /* ── USD spot-pair liquidity (orderbook market-making) ── */
  const [usdAsset, setUsdAsset] = useState<Asset | null>(null);
  const [usdInput, setUsdInput] = useState('');
  const [lpBusy, setLpBusy] = useState(false);

  const usdMark = usdAsset && prices[usdAsset]
    ? Number(prices[usdAsset]!.price_usd_micro) / 1_000_000 : 0;

  const assetBal = (a: Asset) =>
    portfolio ? Number(a === 'BTC' ? portfolio.btc : a === 'ETH' ? portfolio.eth : portfolio.vara) / 1e5 : 0;
  const usdBal = portfolio ? Number(portfolio.usd) / 100 : 0;

  const openUsdModal = (a: Asset) => { setUsdAsset(a); setUsdInput(''); };
  const closeUsdModal = () => { if (!lpBusy) setUsdAsset(null); };

  /* Two-sided quote levels for the current mark (contract price tick = $1000) */
  const usdQuote = (() => {
    if (usdMark <= 0) return null;
    const markTick = Math.max(2, Math.round(usdMark / 1000));
    const bidTick = Math.max(1, markTick - 1);
    const askTick = markTick + 1;
    return { bidTick, askTick, bidPriceUsd: bidTick * 1000, askPriceUsd: askTick * 1000 };
  })();

  const provideUsdLiquidity = async () => {
    if (!program || !account || !usdAsset || !usdQuote) return;
    const usd = parseFloat(usdInput);
    if (isNaN(usd) || usd <= 0) { error('Enter a valid USD amount'); return; }

    const halfUsd = usd / 2;
    if (halfUsd > usdBal) {
      error(`Insufficient USD. You have $${usdBal.toFixed(2)}, need $${halfUsd.toFixed(2)} for the bid side.`);
      return;
    }

    const bidQty = BigInt(Math.max(1, Math.round((halfUsd / usdQuote.bidPriceUsd) * 1e5)));
    const sellAssetQty = Math.min(halfUsd / usdQuote.askPriceUsd, assetBal(usdAsset));
    const sellQty = sellAssetQty > 0 ? BigInt(Math.round(sellAssetQty * 1e5)) : 0n;

    setLpBusy(true);
    try {
      const { signer } = await web3FromSource(account.meta.source);

      /* Bid: resting buy below mark — provides USD-side liquidity */
      const bt = program.orderbook.placeLimit('Buy', usdAsset, BigInt(usdQuote.bidTick), bidQty);
      await bt.withAccount(account.address, { signer }).calculateGas(true, 100);
      const { response: br } = await bt.signAndSend();
      const bres = await br();
      if (bres && typeof bres === 'object' && 'err' in bres) throw new Error(JSON.stringify((bres as any).err));

      /* Ask: resting sell above mark — provides asset-side liquidity (only if held) */
      if (sellQty > 0n) {
        const st = program.orderbook.placeLimit('Sell', usdAsset, BigInt(usdQuote.askTick), sellQty);
        await st.withAccount(account.address, { signer }).calculateGas(true, 100);
        const { response: sr } = await st.signAndSend();
        const sres = await sr();
        if (sres && typeof sres === 'object' && 'err' in sres) throw new Error(JSON.stringify((sres as any).err));
      }

      success(sellQty > 0n
        ? `Liquidity added · ${usdAsset}/USD two-sided quote is live`
        : `Bid liquidity added · ${usdAsset}/USD`);
      setUsdAsset(null);
      refreshPortfolio(); refreshAll();
      setTimeout(() => { refreshPortfolio(); refreshAll(); }, 2500);
    } catch (e: any) {
      error(parseContractError(e?.message || String(e)));
    } finally {
      setLpBusy(false);
    }
  };

  const fmt = (val: bigint | number | string) =>
    (Number(val) / 10**5).toLocaleString(undefined, { maximumFractionDigits: 6 });

  const isBusy = txState.visible && txState.stage !== 'failed' && txState.stage !== 'confirmed';

  return (
    <>
      <div className={styles.container}>
        <div className={styles.header}>
          <h1>Liquidity Pools</h1>
          <button className={styles.createBtn} onClick={() => setShowCreate(!showCreate)}>
            {showCreate ? 'Cancel' : '+ Create Pool'}
          </button>
        </div>

        {showCreate && (
          <Card title="Create Pool">
            <div className={styles.createForm}>
              <select value={newA} onChange={e => setNewA(e.target.value as Asset)} aria-label="First asset">
                {['BTC', 'ETH', 'VARA'].map(a => <option key={a}>{a}</option>)}
              </select>
              <span style={{ color: 'var(--text-secondary)' }}>/</span>
              <select value={newB} onChange={e => setNewB(e.target.value as Asset)} aria-label="Second asset">
                {['BTC', 'ETH', 'VARA'].map(a => <option key={a}>{a}</option>)}
              </select>
              <button onClick={handleCreatePool} disabled={isBusy}>
                {isBusy ? 'Creating...' : 'Create'}
              </button>
            </div>
          </Card>
        )}

        {/* ── USD Spot Pairs ── */}
        <Card title="USD Spot Pairs — Orderbook Liquidity">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12, padding: '4px 0' }}>
            {(['BTC', 'ETH', 'VARA'] as Asset[]).map(asset => {
              const feed    = prices[asset];
              const markPrice = feed ? Number(feed.price_usd_micro) / 1_000_000 : 0;
              const change  = feed ? Number(feed.change_24h_bps) / 100 : 0;
              const ob      = orderbooks[asset] || { bids: [], asks: [] };
              const bestBid = ob.bids.length > 0 ? Number(ob.bids[0][0]) * 1000 : 0;
              const bestAsk = ob.asks.length > 0 ? Number(ob.asks[0][0]) * 1000 : 0;
              const totalOrders = ob.bids.length + ob.asks.length;
              return (
                <div key={asset} style={{
                  background: 'var(--card-bg-hover)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-md)',
                  padding: '12px 14px',
                  display: 'flex', flexDirection: 'column', gap: 8,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: 700, fontFamily: 'var(--font-mono)', fontSize: 14, color: 'var(--primary)' }}>
                      {asset}/USD
                    </span>
                    <span style={{ fontSize: 11, color: change >= 0 ? 'var(--buy-green)' : 'var(--sell-red)', fontWeight: 600 }}>
                      {change >= 0 ? '+' : ''}{change.toFixed(2)}%
                    </span>
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-main)' }}>
                    {markPrice > 0 ? `$${markPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '---'}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, fontSize: 11, color: 'var(--text-secondary)' }}>
                    <div>
                      <div style={{ marginBottom: 2 }}>Best Bid</div>
                      <div style={{ color: 'var(--buy-green)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                        {bestBid > 0 ? `$${bestBid.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '---'}
                      </div>
                    </div>
                    <div>
                      <div style={{ marginBottom: 2 }}>Best Ask</div>
                      <div style={{ color: 'var(--sell-red)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                        {bestAsk > 0 ? `$${bestAsk.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '---'}
                      </div>
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', borderTop: '1px solid var(--border-color)', paddingTop: 6 }}>
                    {totalOrders > 0 ? `${totalOrders} open orders` : 'No orders yet'}
                  </div>
                  <button
                    onClick={() => openUsdModal(asset)}
                    style={{
                      background: 'var(--primary)', color: '#000', borderRadius: 'var(--radius-sm)',
                      fontWeight: 700, fontSize: 12, padding: '6px 0', minHeight: 32, cursor: 'pointer',
                      border: 'none', width: '100%', marginTop: 2,
                    }}
                  >
                    + Add Liquidity
                  </button>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 12, padding: '10px 12px', background: 'rgba(0,178,114,0.08)', borderRadius: 'var(--radius-sm)', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            USD pairs are orderbook markets. Adding liquidity places a resting Buy bid and Sell ask around the current price — you earn the spread whenever either side is matched.
          </div>
        </Card>

        <Card title="AMM Pools">
          {pools.length === 0 && (
            <EmptyState
              title={marketLoading ? 'Loading...' : 'No Pools Yet'}
              description={marketLoading ? 'Fetching pool data...' : 'Be the first to create a liquidity pool.'}
              action={account && !showCreate ? { label: '+ Create Pool', onClick: () => setShowCreate(true) } : undefined}
            />
          )}
          {pools.length > 0 && (
            <table className={styles.table}>
              {!isMobile && (
                <thead>
                  <tr>
                    <th scope="col">Pool Pair</th>
                    <th scope="col">Reserve A</th>
                    <th scope="col">Reserve B</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
              )}
              <tbody>
                {pools.map(pool => (
                  <tr key={pool.id.toString()}>
                    <td className={styles.pair} data-label="Pool Pair">{pool.asset_a} / {pool.asset_b}</td>
                    <td data-label={`Reserve ${pool.asset_a}`}>{fmt(pool.reserve_a)}</td>
                    <td data-label={`Reserve ${pool.asset_b}`}>{fmt(pool.reserve_b)}</td>
                    <td data-label="Actions">
                      <button className={styles.manageBtn} onClick={() => openManage(pool)}>
                        Manage
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="My Liquidity">
          {myLp.length === 0 && (
            <EmptyState
              title="No Active Positions"
              description="Add liquidity to a pool to start earning fees."
            />
          )}
          {myLp.map((pos: any) => {
            const pool = pools.find(p => Number(p.id) === Number(pos.pool_id));
            return (
              <div key={pos.pool_id.toString()} className={styles.lpRow}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <span style={{ fontWeight: 600 }}>
                      {pool ? `${pool.asset_a} / ${pool.asset_b}` : `Pool #${pos.pool_id.toString()}`}
                    </span>
                    <div style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 2 }}>
                      LP tokens: {fmt(pos.amount)}
                    </div>
                  </div>
                  {pool && (
                    <button className={styles.manageBtn} onClick={() => openManage(pool)}>
                      Manage
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </Card>
      </div>

      {/* ── Manage Modal ── */}
      {managed && (
        <div className={styles.modalOverlay} onClick={closeModal} role="dialog" aria-modal="true"
          aria-label={`Manage ${managed.pool.asset_a}/${managed.pool.asset_b} pool`}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <h3>{managed.pool.asset_a} / {managed.pool.asset_b}</h3>

            <div className={styles.poolInfoBox}>
              <span>Reserve {managed.pool.asset_a}: {fmt(managed.pool.reserve_a)}</span>
              <span>Reserve {managed.pool.asset_b}: {fmt(managed.pool.reserve_b)}</span>
              {managed.myLp > 0 && (
                <span className={styles.lpBadge}>My LP: {fmt(managed.myLp)}</span>
              )}
            </div>

            <div className={styles.modalTabs}>
              <button
                className={`${styles.modalTab} ${modalMode === 'add' ? styles.modalTabActive : ''}`}
                onClick={() => setModalMode('add')}
              >
                Add Liquidity
              </button>
              <button
                className={`${styles.modalTab} ${modalMode === 'remove' ? styles.modalTabActive : ''}`}
                onClick={() => setModalMode('remove')}
                disabled={managed.myLp === 0}
              >
                Remove
              </button>
            </div>

            {modalMode === 'add' && (
              <>
                <div className={styles.formGroup}>
                  <label>Amount {managed.pool.asset_a}</label>
                  <input
                    type="number"
                    value={amountA}
                    onChange={e => setAmountA(e.target.value)}
                    placeholder="0.00000000"
                    min="0"
                  />
                </div>
                <div className={styles.formGroup}>
                  <label>Amount {managed.pool.asset_b}</label>
                  <input
                    type="number"
                    value={amountB}
                    onChange={e => setAmountB(e.target.value)}
                    placeholder="0.00000000"
                    min="0"
                  />
                </div>
                <div className={styles.modalActions}>
                  <button className={styles.btnSecondary} onClick={closeModal}>Cancel</button>
                  <button className={styles.btnPrimary} onClick={handleAddLiquidity} disabled={isBusy || !account}>
                    {isBusy ? 'Processing...' : 'Add Liquidity'}
                  </button>
                </div>
              </>
            )}

            {modalMode === 'remove' && (
              <>
                <div className={styles.formGroup}>
                  <label>LP Amount to Remove (max: {fmt(managed.myLp)})</label>
                  <input
                    type="number"
                    value={lpAmount}
                    onChange={e => setLpAmount(e.target.value)}
                    placeholder="0.00000000"
                    min="0"
                    max={(managed.myLp / 10**5).toString()}
                  />
                </div>
                <button
                  className={styles.btnSecondary}
                  style={{ fontSize: 12, padding: '4px 8px', marginTop: -8 }}
                  onClick={() => setLpAmount((managed.myLp / 10**5).toString())}
                >
                  Max
                </button>
                <div className={styles.modalActions}>
                  <button className={styles.btnSecondary} onClick={closeModal}>Cancel</button>
                  <button className={styles.btnPrimary} onClick={handleRemoveLiquidity} disabled={isBusy || !account || managed.myLp === 0}>
                    {isBusy ? 'Processing...' : 'Remove Liquidity'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── USD Pair Liquidity Modal ── */}
      {usdAsset && (
        <div className={styles.modalOverlay} onClick={closeUsdModal} role="dialog" aria-modal="true"
          aria-label={`Add ${usdAsset}/USD liquidity`}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <h3>{usdAsset} / USD — Add Liquidity</h3>

            <div className={styles.poolInfoBox}>
              <span>Mark price: {usdMark > 0 ? `$${usdMark.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '---'}</span>
              <span>Your USD: ${usdBal.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
              <span>Your {usdAsset}: {assetBal(usdAsset).toLocaleString(undefined, { maximumFractionDigits: 5 })}</span>
            </div>

            <div className={styles.formGroup}>
              <label>Liquidity Amount (USD)</label>
              <input
                type="number"
                value={usdInput}
                onChange={e => setUsdInput(e.target.value)}
                placeholder="100.00"
                min="0"
              />
              {usdBal > 0 && (
                <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                  {[25, 50, 100].map(pct => (
                    <button key={pct} type="button"
                      onClick={() => setUsdInput(((usdBal * pct) / 100).toFixed(2))}
                      style={{
                        flex: 1, background: 'var(--card-bg-hover)', border: '1px solid var(--border-color)',
                        color: 'var(--text-secondary)', borderRadius: 'var(--radius-sm)', fontSize: 12,
                        padding: '4px 0', minHeight: 30, cursor: 'pointer',
                      }}>
                      {pct}%
                    </button>
                  ))}
                </div>
              )}
            </div>

            {usdQuote && parseFloat(usdInput) > 0 && (() => {
              const half = parseFloat(usdInput) / 2;
              const bidQty = half / usdQuote.bidPriceUsd;
              const sellQty = Math.min(half / usdQuote.askPriceUsd, assetBal(usdAsset));
              return (
                <div className={styles.poolInfoBox}>
                  <span style={{ color: 'var(--buy-green)' }}>
                    Bid: buy {bidQty.toFixed(5)} {usdAsset} @ ${usdQuote.bidPriceUsd.toLocaleString()}
                  </span>
                  {sellQty > 0 ? (
                    <span style={{ color: 'var(--sell-red)' }}>
                      Ask: sell {sellQty.toFixed(5)} {usdAsset} @ ${usdQuote.askPriceUsd.toLocaleString()}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--text-secondary)' }}>
                      Ask: skipped (no {usdAsset} balance) — bid-only liquidity
                    </span>
                  )}
                </div>
              );
            })()}

            <div className={styles.modalActions}>
              <button className={styles.btnSecondary} onClick={closeUsdModal} disabled={lpBusy}>Cancel</button>
              <button className={styles.btnPrimary} onClick={provideUsdLiquidity} disabled={lpBusy || !account || usdMark <= 0}>
                {lpBusy ? 'Placing orders...' : 'Add Liquidity'}
              </button>
            </div>
            {!account && <div style={{ fontSize: 12, color: 'var(--text-secondary)', textAlign: 'center' }}>Connect wallet to provide liquidity</div>}
          </div>
        </div>
      )}

      <TxStatusOverlay state={txState} onClose={resetTx} />
    </>
  );
}
