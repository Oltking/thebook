import { useAccount } from '@gear-js/react-hooks';
import { web3Accounts, web3Enable } from '@polkadot/extension-dapp';
import { decodeAddress } from '@polkadot/util-crypto';
import { u8aToHex } from '@polkadot/util';
import type { InjectedAccountWithMeta } from '@polkadot/extension-inject/types';
import { Wallet, UserPlus, Menu, TrendingUp, TrendingDown, LogOut } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import styles from './Header.module.css';
import { usePortfolio } from '../../hooks/usePortfolio';
import { useToast } from '../ui/Toast';
import { useViewport } from '../../hooks/useViewport';
import { AccountSelector } from '../ui/AccountSelector';
import { ThemeToggle } from '../ui/ThemeToggle';
import { useMarketData } from '../../providers/MarketDataProvider';
import { formatUsdPrice } from '../../lib/format';

interface HeaderProps {
  onMenuClick: () => void;
  onEnterHive: () => void;
  /** Which world this header sits in. Drives the active switch side + extras. */
  world?: 'trade' | 'hive';
  onExitHive?: () => void;
  onDeploy?: () => void;
}


export function Header({ onMenuClick, onEnterHive, world = 'trade', onExitHive, onDeploy }: HeaderProps) {
  const { account, login, logout } = useAccount();
  const { portfolio, loading } = usePortfolio();
  const { error } = useToast();
  const { isMobile } = useViewport();
  const { prices } = useMarketData();
  const [showAccountSelector, setShowAccountSelector] = useState(false);

  const handleConnect = useCallback(async () => {
    const exts = await web3Enable('thebookdex');
    if (exts.length === 0) {
      error('No wallet extension detected. Install Polkadot.js or SubWallet.');
      return;
    }
    const allAccounts = await web3Accounts();
    if (allAccounts.length === 0) {
      error('No accounts found in your wallet extension.');
      return;
    }
    if (allAccounts.length === 1) {
      const acc = allAccounts[0];
      login({
        ...acc,
        decodedAddress: u8aToHex(decodeAddress(acc.address)),
        signer: exts[0].signer,
      });
      return;
    }
    setShowAccountSelector(true);
  }, [error, login]);

  // Let any view (e.g. empty-state CTAs) trigger the wallet connect flow.
  useEffect(() => {
    const onConnect = () => { handleConnect(); };
    window.addEventListener('thebookdex:connect', onConnect);
    return () => window.removeEventListener('thebookdex:connect', onConnect);
  }, [handleConnect]);

  const handleAccountSelect = useCallback((acc: InjectedAccountWithMeta) => {
    web3Enable('thebookdex').then(exts => {
      login({
        ...acc,
        decodedAddress: u8aToHex(decodeAddress(acc.address)),
        signer: exts[0].signer,
      });
    });
    setShowAccountSelector(false);
  }, [login]);

  const handleJoin = useCallback(() => {
    // Agent creation requires a name + strategy, so open the wizard rather than
    // joining blind. The wizard calls join(name, strategy) on submit.
    window.dispatchEvent(new Event('thebookdex:open-wizard'));
  }, []);

  const formatUsd = (val: bigint | number | string) => {
    return (Number(val) / 100).toLocaleString(undefined, { minimumFractionDigits: 2 });
  };

  const priceTicker = [
    { asset: 'BTC', data: prices.BTC },
    { asset: 'ETH', data: prices.ETH },
    { asset: 'VARA', data: prices.VARA },
  ];

  const isHive = world === 'hive';

  return (
    <>
      <header className={`${styles.header} ${isHive ? styles.headerFull : ''}`}>
        {isMobile && !isHive && (
          <button onClick={onMenuClick} className={styles.menuBtn} aria-label="Open menu">
            <Menu size={22} />
          </button>
        )}
        <div className={styles.logo}>
          <img src="/logo.png" alt="" className={styles.logoMark} aria-hidden="true" />
          <span className={styles.logoText}><span className={styles.accent}>the</span>book</span>
        </div>

        {/* Hive / Trade world switch - centered, same position as the Hive's.
            The Hive is the first side of the app, so it sits on the left. */}
        <div className={styles.modeSwitch} role="tablist" aria-label="Mode">
          <button role="tab" className={isHive ? styles.modeOn : ''} aria-selected={isHive}
            onClick={!isHive ? onEnterHive : undefined}>⬡ The Hive</button>
          <button role="tab" className={!isHive ? styles.modeOn : ''} aria-selected={!isHive}
            onClick={isHive ? onExitHive : undefined}>Trade</button>
        </div>

        {/* Live public price ticker. Hidden once connected, where the right side
            fills with balance + account and would crowd the centered switch. */}
        {!isMobile && !account && (
          <div className={styles.ticker}>
            {priceTicker.map(({ asset, data }) => {
              const usd = data?.price_usd_micro ? Number(data.price_usd_micro) / 1_000_000 : null;
              return (
                <div key={asset} className={styles.tickerItem}>
                  <span className={styles.tickerAsset}>{asset}</span>
                  <span className={styles.tickerPrice}>{formatUsdPrice(usd)}</span>
                  {usd !== null && data?.change_24h_bps !== undefined && (
                    <span className={Number(data.change_24h_bps) >= 0 ? styles.tickerUp : styles.tickerDown}>
                      {Number(data.change_24h_bps) >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                      {(Number(data.change_24h_bps) / 100).toFixed(2)}%
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className={styles.actions}>
          <ThemeToggle />
          {isHive && onDeploy && (
            <button className={styles.deployHeaderBtn} onClick={onDeploy}>
              {isMobile ? '+ Agent' : '+ Deploy agent'}
            </button>
          )}
          {account && !isMobile && (
            <div className={styles.balanceInfo}>
              <span className={styles.balanceLabel}>Balance:</span>
              <span className={styles.balanceValue}>
                {portfolio ? `$${formatUsd(portfolio.usd)}` : '---'}
              </span>
            </div>
          )}

          {account ? (
            <div className={styles.accountInfo}>
              {!portfolio && (
                <button onClick={handleJoin} className={styles.joinButton} disabled={loading}>
                  <UserPlus size={16} />
                  {loading ? '...' : 'Create Agent'}
                </button>
              )}
              {!isMobile && (
                <span className={styles.address}>{account.decodedAddress.slice(0, 6)}...{account.decodedAddress.slice(-4)}</span>
              )}
              {isMobile ? (
                <button onClick={logout} className={styles.iconBtn} aria-label="Disconnect wallet" title="Disconnect">
                  <LogOut size={18} />
                </button>
              ) : (
                <button onClick={logout} className={styles.connectButton}>Disconnect</button>
              )}
            </div>
          ) : (
            <button onClick={handleConnect} className={styles.connectButton}>
              <Wallet size={18} />
              {isMobile ? 'Connect' : 'Connect Wallet'}
            </button>
          )}
        </div>
      </header>

      {showAccountSelector && (
        <AccountSelector onSelect={handleAccountSelect} onClose={() => setShowAccountSelector(false)} />
      )}
    </>
  );
}
