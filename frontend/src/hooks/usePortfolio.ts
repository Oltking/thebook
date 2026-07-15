import { useEffect, useState, useCallback, useRef } from 'react';
import { useSails } from './useSails';
import { web3FromSource } from '@polkadot/extension-dapp';

export interface Portfolio {
  usd: bigint;
  btc: bigint;
  eth: bigint;
  vara: bigint;
}

const JOINED_KEY = 'thebookdex:joined';
const POLL_MS = 4_000;

export function usePortfolio() {
  const { program, account, isReady } = useSails();
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [loading, setLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchPortfolio = useCallback(async () => {
    if (!program || !account) return;
    try {
      const result = await program.orderbook.getPortfolio().withAddress(account.decodedAddress).call();
      if (result && Array.isArray(result)) {
        const usd  = BigInt(result[0]?.toString() || '0');
        const btc  = BigInt(result[1]?.toString() || '0');
        const eth  = BigInt(result[2]?.toString() || '0');
        const vara = BigInt(result[3]?.toString() || '0');
        if (usd === 0n && btc === 0n && eth === 0n && vara === 0n) {
          /* Only show "Join DEX" if they've never joined this account before */
          const prevJoined = localStorage.getItem(`${JOINED_KEY}:${account.address}`) === '1';
          setPortfolio(prevJoined ? { usd, btc, eth, vara } : null);
        } else {
          localStorage.setItem(`${JOINED_KEY}:${account.address}`, '1');
          setPortfolio({ usd, btc, eth, vara });
        }
      }
    } catch (e) {
      console.error('Failed to fetch portfolio:', e);
    }
  }, [program, account]);

  useEffect(() => {
    if (!isReady || !account) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    fetchPortfolio();
    pollRef.current = setInterval(() => { if (!document.hidden) fetchPortfolio(); }, POLL_MS);
    const onVisible = () => { if (!document.hidden) fetchPortfolio(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [isReady, account, fetchPortfolio]);

  /** Create the agent on-chain. Returns null on success, or an error string. */
  const join = async (name: string, strategy: AgentStrategy): Promise<string | null> => {
    if (!program || !account) return 'Wallet not ready';
    setLoading(true);
    try {
      const { signer } = await web3FromSource(account.meta.source);
      const transaction = program.orderbook.join(name, strategy);
      await transaction.withAccount(account.address, { signer }).calculateGas(true, 100);
      const { response } = await transaction.signAndSend();
      await response();
      localStorage.setItem(`${JOINED_KEY}:${account.address}`, '1');
      await fetchPortfolio();
      return null;
    } catch (e: any) {
      console.error('Join failed:', e);
      return e?.message || String(e);
    } finally {
      setLoading(false);
    }
  };

  return { portfolio, join, loading, refresh: fetchPortfolio };
}
