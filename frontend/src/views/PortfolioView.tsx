import { Card } from '../components/ui/Card';
import { usePortfolio } from '../hooks/usePortfolio';
import { useSails } from '../hooks/useSails';
import { useVault } from '../hooks/useVault';
import { useMarketData } from '../providers/MarketDataProvider';
import { TOKENS_CONFIGURED } from '../consts';
import styles from './PortfolioView.module.css';
import { useState, useEffect, useCallback } from 'react';
import { web3FromSource } from '@polkadot/extension-dapp';
import { useToast } from '../components/ui/Toast';
import { parseContractError } from '../lib/errors';
import { useTxStatus, TxStatusOverlay } from '../components/ui/TxStatus';
import { EmptyState } from '../components/ui/EmptyState';
import { PageHeader } from '../components/ui/PageHeader';
import { ArrowUpRight, ArrowDownRight, Loader2, X } from 'lucide-react';

// Display decimals per asset double as the internal-unit scale: a human amount ×
// 10^decimals is the integer unit the contract (and its backing VFT) moves.
type VaultModal = { name: string; kind: TokenKind; decimals: number; mode: 'deposit' | 'withdraw' };

export function PortfolioView() {
  const { portfolio, loading, refresh: refreshPortfolio } = usePortfolio();
  const { program, account, isReady } = useSails();
  const { deposit, withdraw, busy: vaultBusy, step: vaultStep } = useVault();
  const { refreshAll, prices } = useMarketData();
  const [orders, setOrders] = useState<any[]>([]);
  const [cancelling, setCancelling] = useState<number | null>(null);
  const [modal, setModal] = useState<VaultModal | null>(null);
  const [modalAmount, setModalAmount] = useState('');
  const { success, error, info } = useToast();
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

  const openDeposit = useCallback((name: string, kind: TokenKind, decimals: number) => {
    if (!TOKENS_CONFIGURED) {
      info('Wrapped token programs are not configured for this deployment yet.');
      return;
    }
    setModalAmount('');
    setModal({ name, kind, decimals, mode: 'deposit' });
  }, [info]);

  const openWithdraw = useCallback((name: string, kind: TokenKind, decimals: number) => {
    if (!TOKENS_CONFIGURED) {
      info('Wrapped token programs are not configured for this deployment yet.');
      return;
    }
    setModalAmount('');
    setModal({ name, kind, decimals, mode: 'withdraw' });
  }, [info]);

  const submitVault = useCallback(async () => {
    if (!modal) return;
    const human = Number(modalAmount);
    if (!isFinite(human) || human <= 0) { error('Enter a valid amount.'); return; }
    const units = BigInt(Math.round(human * 10 ** modal.decimals));
    if (units <= 0n) { error('Amount is too small.'); return; }
    const err = modal.mode === 'deposit'
      ? await deposit(modal.kind, units)
      : await withdraw(modal.kind, units);
    if (err) {
      error(parseContractError(err));
      return;
    }
    success(`${modal.mode === 'deposit' ? 'Deposited' : 'Withdrew'} ${human} ${modal.name}.`);
    setModal(null);
    refreshPortfolio();
    setTimeout(refreshPortfolio, 2500);
  }, [modal, modalAmount, deposit, withdraw, error, success, refreshPortfolio]);

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
    { name: 'USD',  kind: 'Usd' as TokenKind,  amount: portfolio.usd,  decimals: 2, value: usdVal },
    { name: 'BTC',  kind: 'Btc' as TokenKind,  amount: portfolio.btc,  decimals: 5, value: btcVal },
    { name: 'ETH',  kind: 'Eth' as TokenKind,  amount: portfolio.eth,  decimals: 5, value: ethVal },
    { name: 'VARA', kind: 'Vara' as TokenKind, amount: portfolio.vara, decimals: 5, value: varaVal },
  ];

  return (
    <>
      <div className={styles.container}>
        <PageHeader eyebrow="Your account" title="Portfolio"
          subtitle="Your balances, open orders, and liquidity — all backed by real testnet tokens." />

        <div className={styles.grid}>
          <Card title="Asset Balances">
            {assets.every(a => Number(a.amount) === 0) ? (
              <EmptyState
                title="Empty Portfolio"
                description="Claim and deposit wrapped test tokens to start trading."
                action={{ label: 'Deposit USD', onClick: () => openDeposit('USD', 'Usd', 2) }}
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
                            onClick={() => openDeposit(asset.name, asset.kind, asset.decimals)} aria-label={`Deposit ${asset.name}`}>
                            <ArrowDownRight size={14} />
                          </button>
                          <button className={styles.actionBtn} title={`Withdraw ${asset.name}`}
                            onClick={() => openWithdraw(asset.name, asset.kind, asset.decimals)} aria-label={`Withdraw ${asset.name}`}>
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

      {modal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${modal.mode} ${modal.name}`}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
          }}
          onClick={() => !vaultBusy && setModal(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 'min(92vw, 380px)', background: 'var(--bg-elevated, #16161f)',
              border: '1px solid var(--border-color, #2a2a3a)', borderRadius: 12, padding: 20,
              position: 'relative',
            }}
          >
            <button
              onClick={() => !vaultBusy && setModal(null)}
              aria-label="Close"
              style={{ position: 'absolute', top: 12, right: 12, background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}
            >
              <X size={18} />
            </button>
            <h3 style={{ margin: '0 0 4px', textTransform: 'capitalize' }}>
              {modal.mode} {modal.name}
            </h3>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 16px' }}>
              {modal.mode === 'deposit'
                ? 'Move wrapped tokens from your wallet into the DEX vault.'
                : 'Withdraw tokens from the DEX vault back to your wallet.'}
            </p>
            <input
              autoFocus
              type="number"
              min="0"
              step="any"
              value={modalAmount}
              onChange={(e) => setModalAmount(e.target.value)}
              placeholder={`Amount of ${modal.name}`}
              style={{
                width: '100%', boxSizing: 'border-box', padding: '12px 14px', fontSize: 16,
                border: '1px solid var(--border-color, #2a2a3a)', borderRadius: 10,
                background: 'var(--bg, #0f0f16)', color: 'inherit', marginBottom: 14,
              }}
            />
            <button
              onClick={submitVault}
              disabled={vaultBusy}
              style={{
                width: '100%', padding: '12px 14px', fontSize: 15, fontWeight: 600,
                border: 'none', borderRadius: 10, cursor: vaultBusy ? 'default' : 'pointer',
                background: 'var(--accent)', color: 'var(--on-accent)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              }}
            >
              {vaultBusy && <Loader2 size={16} className={styles.spin ?? ''} />}
              {vaultBusy
                ? (vaultStep === 'approving' ? 'Approving the DEX...'
                  : vaultStep === 'depositing' ? 'Depositing...'
                  : vaultStep === 'withdrawing' ? 'Withdrawing...'
                  : 'Confirming...')
                : `${modal.mode === 'deposit' ? 'Deposit' : 'Withdraw'} ${modal.name}`}
            </button>
          </div>
        </div>
      )}

      <TxStatusOverlay state={txState} onClose={resetTx} />
    </>
  );
}
