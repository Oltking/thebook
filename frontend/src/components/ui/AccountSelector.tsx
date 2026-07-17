import { useState, useEffect, useCallback } from 'react';
import { web3Accounts } from '@polkadot/extension-dapp';
import type { InjectedAccountWithMeta } from '@polkadot/extension-inject/types';
import { Wallet, ExternalLink, Loader2, AlertCircle } from 'lucide-react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import styles from './AccountSelector.module.css';

interface AccountSelectorProps {
  onSelect: (account: InjectedAccountWithMeta) => void;
  onClose: () => void;
}

export function AccountSelector({ onSelect, onClose }: AccountSelectorProps) {
  const [accounts, setAccounts] = useState<InjectedAccountWithMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedAddr, setSelectedAddr] = useState<string | null>(null);

  useEffect(() => {
    const detect = async () => {
      setLoading(true);
      try {
        const all = await web3Accounts();
        if (all.length === 0) {
          setError('No accounts found. Create one in your wallet extension.');
          return;
        }
        setAccounts(all);
      } catch {
        setError('Failed to detect wallet. Try refreshing the page.');
      } finally {
        setLoading(false);
      }
    };
    detect();
  }, []);

  const handleSelect = useCallback((acc: InjectedAccountWithMeta) => {
    setSelectedAddr(acc.address);
    onSelect(acc);
  }, [onSelect]);

  const trapRef = useFocusTrap<HTMLDivElement>(true, onClose);

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div ref={trapRef} tabIndex={-1} className={styles.modal} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Select wallet account">
        <div className={styles.header}>
          <Wallet size={22} />
          <h3>Select Account</h3>
        </div>

        {loading && (
          <div className={styles.loading}>
            <Loader2 size={24} className={styles.spin} />
            <span>Detecting wallet accounts...</span>
          </div>
        )}

        {error && (
          <div className={styles.error}>
            <AlertCircle size={18} />
            <span>{error}</span>
          </div>
        )}

        {!loading && !error && (
          <div className={styles.list}>
            {accounts.map(acc => (
              <button
                key={acc.address}
                className={`${styles.account} ${selectedAddr === acc.address ? styles.selected : ''}`}
                onClick={() => handleSelect(acc)}
              >
                <div className={styles.avatar}>
                  <Wallet size={18} />
                </div>
                <div className={styles.info}>
                  <span className={styles.name}>{acc.meta.name || 'Unnamed Account'}</span>
                  <span className={styles.address}>{acc.address.slice(0, 8)}...{acc.address.slice(-6)}</span>
                </div>
                <div className={styles.source}>
                  <ExternalLink size={14} />
                  {acc.meta.source || 'Wallet'}
                </div>
              </button>
            ))}
          </div>
        )}

        <button onClick={onClose} className={styles.cancelBtn}>
          Cancel
        </button>
      </div>
    </div>
  );
}
