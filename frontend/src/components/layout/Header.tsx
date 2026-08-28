import { useAccount } from '@gear-js/react-hooks';
import { web3Accounts, web3Enable } from '@polkadot/extension-dapp';
import { decodeAddress } from '@polkadot/util-crypto';
import { u8aToHex } from '@polkadot/util';
import type { InjectedAccountWithMeta } from '@polkadot/extension-inject/types';
import { Wallet, Menu, TrendingUp, TrendingDown, LogOut } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import styles from './Header.module.css';
import { Logo } from '../ui/Logo';
import { useToast } from '../ui/Toast';
import { useViewport } from '../../hooks/useViewport';
import { AccountSelector } from '../ui/AccountSelector';
import { ThemeToggle } from '../ui/ThemeToggle';
import { useMarketData } from '../../providers/MarketDataProvider';
import { formatUsdPrice } from '../../lib/format';

interface HeaderProps {
  onMenuClick: () => void;
}

export function Header({ onMenuClick }: HeaderProps) {
  const { account, login, logout } = useAccount();
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

  const priceTicker = [
    { asset: 'BTC', data: prices.BTC },
    { asset: 'ETH', data: prices.ETH },
    { asset: 'VARA', data: prices.VARA },
  ];

  return (
    <>
      <header className={styles.header}>
        {isMobile && (
          <button onClick={onMenuClick} className={styles.menuBtn} aria-label="Open menu">
            <Menu size={22} />
          </button>
        )}
        <div className={styles.logo}>
          <Logo className={styles.logoMark} />
          <span className={styles.logoText}><span className={styles.accent}>the</span>book</span>
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
          <ThemeToggle className={styles.headerThemeToggle} />
          {account ? (
            <div className={styles.accountInfo}>
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
