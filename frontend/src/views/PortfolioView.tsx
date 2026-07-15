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
import { ArrowUpRight, ArrowDownRight } from 'lucide-react';

export function PortfolioView() {
  const { portfolio, loading, refresh: refreshPortfolio } = usePortfolio();
  const { program, account, isReady } = useSails();
  const { refreshAll, prices } = useMarketData();
  const [orders, setOrders] = useState<any[]>([]);
  const [cancelling, setCancelling] = useState<number | null>(null);
  const { success, error, info } = useToast();
  const { txState, resetTx } = useTxStatus();

  const fetchOrders = useCallback(() => {
    if (!program || !isReady || !account) return;
    program.orderbook.getMyOrders().withAddress(account.decodedAddress).call().then((result: any) => {
      if (result && Array.isArray(result)) setOrders(result);
    }).catch(console.error);
  }, [program, isReady, account]);

  /* Refresh orders on mount and whenever portfolio changes (balance update = trade happened) */
  useEffect(() => { fetchOrders(); }, [fetchOrders, portfolio]);

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

  const handleDeposit = useCallback(() => {
    info('This is a demo DEX — balances are virtual. Click "Join DEX" to receive your free starting balance: $1,000 · 1 BTC · 10 ETH · 10,000 VARA.');
  }, [info]);

  const handleWithdraw = useCallback(() => {
    info('This is a demo DEX — balances are virtual. Trade, swap, and provide liquidity to grow your portfolio!');
  }, [info]);

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
            title={loading ? 'Loading...' : 'Welcome to thebookdex'}
            description={loading ? 'Loading portfolio...' : 'Join the DEX to start trading and tracking your balances.'}
            action={!loading && account ? {
              label: 'Create Agent',
              onClick: () => window.dispatchEvent(new Event('thebookdex:open-wizard')),
            } : undefined}
          />
        </Card>
      </div>
    );
  }

  const priceUsd = (a: Asset) => {
    const f = prices[a];
    return f ? Number(f.price_usd_micro) / 1_000_000 : 0;
  };

  const usdVal  = Number(portfolio.usd) / 100;
  const btcVal  = (Number(portfolio.btc)  / 1e5) * priceUsd('BTC');
  const ethVal  = (Number(portfolio.eth)  / 1e5) * priceUsd('ETH');
  const varaVal = (Number(portfolio.vara) / 1e5) * priceUsd('VARA');
  const netWorth = usdVal + btcVal + ethVal + varaVal;
  const pricesReady = priceUsd('BTC') > 0 || priceUsd('ETH') > 0;

  /* "Open Orders" should only list orders still resting on the book */
  const openOrders = orders.filter((o: any) => o[6] === 'Open' || o[6] === 'Partial');

  const assets = [
    { name: 'USD',  amount: portfolio.usd,  decimals: 2, value: usdVal },
    { name: 'BTC',  amount: portfolio.btc,  decimals: 5, value: btcVal },
    { name: 'ETH',  amount: portfolio.eth,  decimals: 5, value: ethVal },
    { name: 'VARA', amount: portfolio.vara, decimals: 5, value: varaVal },
  ];

  return (
    <>
      <div className={styles.container}>
        <h1>My Portfolio</h1>

        <div className={styles.grid}>
          <Card title="Asset Balances">
            {assets.every(a => Number(a.amount) === 0) ? (
              <EmptyState
                title="Empty Portfolio"
                description="Deposit funds to start trading."
                action={{ label: 'Deposit', onClick: handleDeposit }}
              />
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">Asset</th>
                    <th scope="col">Balance</th>
                    <th scope="col">Value (USD)</th>
                    <th scope="col">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {assets.map((asset) => (
                    <tr key={asset.name}>
                      <td className={styles.assetName}>{asset.name}</td>
                      <td>{formatAmount(asset.amount, asset.decimals)}</td>
                      <td>{asset.name === 'USD' || asset.value > 0
                        ? `$${asset.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : '—'}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button className={styles.actionBtn} title={`Deposit ${asset.name}`}
                            onClick={handleDeposit} aria-label={`Deposit ${asset.name}`}>
                            <ArrowDownRight size={14} />
                          </button>
                          <button className={styles.actionBtn} title={`Withdraw ${asset.name}`}
                            onClick={handleWithdraw} aria-label={`Withdraw ${asset.name}`}>
                            <ArrowUpRight size={14} />
                          </button>
                        </div>
                      </td>
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
                      {pricesReady ? 'USD + assets at market price' : 'USD balance (connect for live asset prices)'}
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
                  <span>${(Number(o[3]) * 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
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
      </div>

      <TxStatusOverlay state={txState} onClose={resetTx} />
    </>
  );
}
