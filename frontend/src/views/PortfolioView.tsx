import { Card } from '../components/ui/Card';
import { usePortfolio } from '../hooks/usePortfolio';
import { useSails } from '../hooks/useSails';
import { useMarketData } from '../providers/MarketDataProvider';
import styles from './PortfolioView.module.css';
import { useState, useEffect, useCallback } from 'react';
import { web3FromSource } from '@polkadot/extension-dapp';
import { useToast } from '../components/ui/Toast';
import { parseContractError } from '../lib/errors';
import { useTxStatus, TxStatusOverlay } from '../components/ui/TxStatus';
import { EmptyState } from '../components/ui/EmptyState';
import { PageHeader } from '../components/ui/PageHeader';

export function PortfolioView() {
  const { portfolio, loading, refresh: refreshPortfolio } = usePortfolio();
  const { program, account, isReady } = useSails();
  const { refreshAll, prices } = useMarketData();
  const [orders, setOrders] = useState<any[]>([]);
  const [cancelling, setCancelling] = useState<number | null>(null);
  const { success, error } = useToast();
  const { txState, resetTx } = useTxStatus();

  const [lpPositions, setLpPositions] = useState<any[]>([]);

  const fetchOrders = useCallback(() => {
    if (!program || !isReady || !account) return;
    program.orderbook.getMyOrders().withAddress(account.decodedAddress).call().then((result: any) => {
      if (result && Array.isArray(result)) setOrders(result);
    }).catch(console.error);
  }, [program, isReady, account]);

  const fetchLpPositions = useCallback(async () => {
    if (!program || !isReady || !account) return;
    try {
      const pools: any[] = await program.amm.listPools().call();
      if (!Array.isArray(pools)) return;
      const mine: any[] = [];
      for (const pool of pools) {
        const pos: any = await program.amm
          .getLpPosition(pool.id, account.decodedAddress)
          .call()
          .catch(() => null);
        if (pos && BigInt(pos.amount?.toString() || '0') > 0n) {
          mine.push({ pool, pos });
        }
      }
      setLpPositions(mine);
    } catch (e) {
      console.error('Failed to fetch LP positions:', e);
    }
  }, [program, isReady, account]);

  /* Refresh orders + LP on mount and whenever portfolio changes (a trade happened) */
  useEffect(() => { fetchOrders(); fetchLpPositions(); }, [fetchOrders, fetchLpPositions, portfolio]);

  const handleCancel = useCallback(async (oid: number | string | bigint) => {
    if (!program || !account) return;
    setCancelling(Number(oid));
    try {
      const { signer } = await web3FromSource(account.meta.source);
      const tx = program.orderbook.cancelOrder(oid);
      await tx.withAccount(account.address, { signer }).calculateGas();
      const { response } = await tx.signAndSend();
      await response();
      success('Order cancelled');
      setOrders(prev => prev.filter((o: any) => Number(o[0]) !== Number(oid)));
      refreshPortfolio();
      refreshAll();
      setTimeout(() => { refreshPortfolio(); fetchOrders(); refreshAll(); }, 2000);
    } catch (e: any) {
      console.error('Cancel failed:', e);
      error(parseContractError(e?.message || String(e)));
    } finally {
      setCancelling(null);
    }
  }, [program, account, success, error, refreshPortfolio, refreshAll, fetchOrders]);

  const formatAmount = (val: bigint | number | string, decimals: number = 2) => {
     const n = Number(val);
     if (isNaN(n)) return '0.00';
     const divisor = 10 ** decimals;
     return (n / divisor).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: decimals });
  };

  if (!portfolio) {
    return (
      <div className={styles.emptyState}>
        <Card title="My Portfolio">
          <EmptyState
            title={loading ? 'Loading...' : account ? 'Welcome to thebookdex' : 'Connect to get started'}
            description={loading ? 'Loading portfolio...' : account
              ? 'Create your agent to start trading and tracking your balances.'
              : 'Connect a wallet to trade, provide liquidity, and track your balances.'}
            action={loading ? undefined : account ? {
              label: 'Create Agent',
              onClick: () => window.dispatchEvent(new Event('thebookdex:open-wizard')),
            } : {
              label: 'Connect wallet',
              onClick: () => window.dispatchEvent(new Event('thebookdex:connect')),
            }}
          />
        </Card>
      </div>
    );
  }

  const priceUsd = (a: Asset) => {
    const f = prices[a];
    return f ? Number(f.price_usd_micro) / 1_000_000 : 0;
  };

  const usdVal  = Number(portfolio.usd) / 1_000_000;
  const btcVal  = (Number(portfolio.btc)  / 1e5) * priceUsd('BTC');
  const ethVal  = (Number(portfolio.eth)  / 1e5) * priceUsd('ETH');
  const varaVal = (Number(portfolio.vara) / 1e5) * priceUsd('VARA');
  const netWorth = usdVal + btcVal + ethVal + varaVal;
  const pricesReady = priceUsd('BTC') > 0 || priceUsd('ETH') > 0;

  /* "Open Orders" should only list orders still resting on the book */
  const openOrders = orders.filter((o: any) => o[6] === 'Open' || o[6] === 'Partial');

  const assets = [
    { name: 'USDT', kind: 'Usd' as TokenKind,  amount: portfolio.usd,  decimals: 2, value: usdVal },
    { name: 'BTC',  kind: 'Btc' as TokenKind,  amount: portfolio.btc,  decimals: 5, value: btcVal },
    { name: 'ETH',  kind: 'Eth' as TokenKind,  amount: portfolio.eth,  decimals: 5, value: ethVal },
    { name: 'VARA', kind: 'Vara' as TokenKind, amount: portfolio.vara, decimals: 5, value: varaVal },
  ];

  return (
    <>
      <div className={styles.container}>
        <PageHeader eyebrow="Your account" title="Portfolio"
          subtitle="Your trading balances, open orders, and liquidity on thebook." />

        <div className={styles.grid}>
          <Card title="Asset Balances">
            {assets.every(a => Number(a.amount) === 0) ? (
              <EmptyState
                title="Empty Portfolio"
                description="Your agent starts with testnet balances - create it to begin trading."
                action={{ label: 'Create Agent', onClick: () => window.dispatchEvent(new Event('thebookdex:open-wizard')) }}
              />
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">Asset</th>
                    <th scope="col">Balance</th>
                    <th scope="col">Value (USDT)</th>
                  </tr>
                </thead>
                <tbody>
                  {assets.map((asset) => (
                    <tr key={asset.name}>
                      <td className={styles.assetName}>{asset.name}</td>
                      <td>{asset.name === 'USDT'
                        ? asset.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                        : formatAmount(asset.amount, asset.decimals)}</td>
                      <td>{asset.name === 'USDT' || asset.value > 0
                        ? `$${asset.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="Total Net Worth">
              <div className={styles.netWorth}>
                  <span className={styles.netWorthValue}>
                      ${netWorth.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                  <span className={styles.netWorthLabel}>
                      {pricesReady ? 'USDT + assets at market price' : 'USDT balance (connect for live asset prices)'}
                  </span>
              </div>
          </Card>
        </div>

        <div className={styles.ordersSection}>
          <Card title="Open Orders">
            {openOrders.length === 0 && (
              <EmptyState
                title="No Open Orders"
                description="Place a limit order on the Trade page to see it here."
              />
            )}
            {openOrders.map((o, i) => (
              <div key={i} className={styles.orderRow}>
                <div>
                  <span style={{ fontWeight: 600 }}>{o[1] as string} {o[2] as string}</span>
                  <span style={{ margin: '0 8px', color: 'var(--text-secondary)' }}>@</span>
                  <span>${(Number(o[3]) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                    Qty: {formatAmount(o[4], 5)} / Filled: {formatAmount(o[5], 5)}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: o[6] === 'Open' ? 'var(--buy-green)' : 'var(--text-secondary)', fontSize: 12, textTransform: 'uppercase' }}>{o[6] as string}</span>
                  {(o[6] === 'Open' || o[6] === 'Partial') && (
                    <button
                      onClick={() => handleCancel(o[0])}
                      disabled={cancelling === Number(o[0])}
                      style={{
                        padding: '6px 14px',
                        borderRadius: 6,
                        border: '1px solid var(--border-color)',
                        background: 'transparent',
                        color: 'var(--text-secondary)',
                        cursor: 'pointer',
                        fontSize: 13,
                        fontWeight: 500,
                        minHeight: 36,
                      }}
                    >
                      {cancelling === Number(o[0]) ? '...' : 'Cancel'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </Card>
        </div>

        <div className={styles.ordersSection}>
          <Card title="My Liquidity">
            {lpPositions.length === 0 ? (
              <EmptyState
                title="No Liquidity Positions"
                description="Add liquidity to a pool on the Pools page to earn swap fees."
              />
            ) : (
              lpPositions.map(({ pool, pos }, i) => (
                <div key={i} className={styles.orderRow}>
                  <div>
                    <span style={{ fontWeight: 600 }}>
                      {pool.asset_a as string}/{pool.asset_b as string}
                    </span>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                      Pooled: {formatAmount(pos.share_a, 5)} {pool.asset_a} · {formatAmount(pos.share_b, 5)} {pool.asset_b}
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    LP: {formatAmount(pos.amount, 5)}
                  </div>
                </div>
              ))
            )}
          </Card>
        </div>
      </div>

      <TxStatusOverlay state={txState} onClose={resetTx} />
    </>
  );
}
