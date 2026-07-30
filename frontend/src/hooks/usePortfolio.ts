import { useEffect, useState, useCallback, useRef } from 'react';
import { useSails } from './useSails';
import { web3FromSource } from '@polkadot/extension-dapp';
import { resolveIdentity } from '../lib/identity';
import { useVoucher } from '../providers/VoucherProvider';

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
  const { apply: applyVoucher } = useVoucher();
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [loading, setLoading] = useState(false);
  // Whether this account already has an on-chain agent identity. `null` = not yet
  // known (still checking). This is the source of truth for "have you joined",
  // NOT balances or a localStorage flag, so a returning account with zero balance
  // isn't wrongly funnelled back through create/claim.
  const [hasJoined, setHasJoined] = useState<boolean | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchPortfolio = useCallback(async () => {
    if (!program || !account) return;
    try {
      // Identity check first: the on-chain identity is authoritative.
      const identity = await resolveIdentity(program, account.decodedAddress).catch(() => null);
      const joined = !!identity;
      setHasJoined(joined);
      if (joined) localStorage.setItem(`${JOINED_KEY}:${account.address}`, '1');

      const result = await program.orderbook.getPortfolio().withAddress(account.decodedAddress).call();
      if (result && Array.isArray(result)) {
        const usd  = BigInt(result[0]?.toString() || '0');
        const btc  = BigInt(result[1]?.toString() || '0');
        const eth  = BigInt(result[2]?.toString() || '0');
        const vara = BigInt(result[3]?.toString() || '0');
        const prevJoined = joined || localStorage.getItem(`${JOINED_KEY}:${account.address}`) === '1';
        if (usd === 0n && btc === 0n && eth === 0n && vara === 0n) {
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
      setHasJoined(account ? null : false);
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
      await applyVoucher(transaction.withAccount(account.address, { signer }) as any).calculateGas(true, 100);
      const { response } = await transaction.signAndSend();
      await response();

      /* Don't claim success on the extrinsic landing alone - verify the identity
         actually persisted on-chain (the Hive and portfolio reads depend on it).
         Retry a few times to allow for block inclusion before giving up. */
      let confirmed = false;
      for (let i = 0; i < 5; i++) {
        const id = await resolveIdentity(program, account.decodedAddress);
        if (id) { confirmed = true; break; }
        await new Promise(r => setTimeout(r, 1500));
      }
      if (!confirmed) {
        return 'The transaction went through but your agent isn\'t showing up on-chain yet. Give it a moment and refresh - if it persists, try again.';
      }

      localStorage.setItem(`${JOINED_KEY}:${account.address}`, '1');
      setHasJoined(true);
      await fetchPortfolio();
      return null;
    } catch (e: any) {
      console.error('Join failed:', e);
      return e?.message || String(e);
    } finally {
      setLoading(false);
    }
  };

  return { portfolio, hasJoined, join, loading, refresh: fetchPortfolio };
}
