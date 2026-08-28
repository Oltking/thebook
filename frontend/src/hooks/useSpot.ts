// Data hooks for the v1 spot CLOB: curated pairs, real wallet balances, token
// allowances to the DEX, and withdrawable claim balances. All amounts are bigint
// (u128/u256 on-chain); format by each token's decimals from its pair.
import { useApi, useAccount } from '@gear-js/react-hooks';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSails } from './useSails';
import { VftProgram } from '../lib/vft';
import { PROGRAM_ID, knownToken } from '../consts';

const POLL_MS = 8_000;

/** The curated market list. Pairs change rarely, so this polls slowly. */
export function useSpotPairs() {
  const { program, isReady } = useSails();
  const [pairs, setPairs] = useState<SpotPair[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!program) return;
    setLoading(true);
    try {
      // Paginated read; the curated list is small, one page covers it (audit L-05).
      const rows = await program.spot.getPairs(0, 200).call();
      setPairs(Array.isArray(rows) ? rows : []);
    } catch (e) {
      console.error('useSpotPairs: failed to read pairs', e);
    } finally {
      setLoading(false);
    }
  }, [program]);

  useEffect(() => {
    if (!isReady) return;
    refresh();
    const iv = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS * 4);
    return () => clearInterval(iv);
  }, [isReady, refresh]);

  return { pairs, loading, refresh };
}

// A VftProgram is cheap to build but we memoize per (api, token) so repeated reads
// don't re-instantiate the registry on every poll.
function useVftFactory() {
  const { api, isApiReady } = useApi();
  return useMemo(() => {
    const cache = new Map<string, VftProgram>();
    return (token: string): VftProgram | null => {
      if (!isApiReady || !api) return null;
      let vft = cache.get(token);
      if (!vft) {
        vft = new VftProgram(api, token as `0x${string}`);
        cache.set(token, vft);
      }
      return vft;
    };
  }, [api, isApiReady]);
}

/** Resolve each token program's symbol (e.g. "wUSDT") from its VFT metadata.
 * Symbols are immutable, so they're fetched once per token and cached. */
export function useTokenSymbols(tokens: string[]) {
  const vftOf = useVftFactory();
  const [symbols, setSymbols] = useState<Record<string, string>>({});
  const key = tokens.join(',');

  useEffect(() => {
    let live = true;
    (async () => {
      const missing = tokens.filter((t) => t && !(t in symbols));
      if (missing.length === 0) return;
      const entries = await Promise.all(
        missing.map(async (t) => {
          const known = knownToken(t)?.symbol;
          try {
            const v = vftOf(t);
            const s = v ? await v.vftMetadata.symbol().call() : '';
            return [t, s || known || short(t)] as const;
          } catch {
            // On-chain symbol read failed: use the curated registry before a raw
            // address, so known markets never show 0x… in the UI.
            return [t, known || short(t)] as const;
          }
        }),
      );
      if (live) setSymbols((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
    })();
    return () => { live = false; };
  }, [key, vftOf]);

  return symbols;
}

/** A short 0x… fallback label when a symbol can't be read. */
function short(addr: string): string {
  return addr.length > 10 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

/** Read the connected wallet's real VFT balance for each token. */
export function useWalletBalances(tokens: string[]) {
  const { account } = useAccount();
  const vftOf = useVftFactory();
  const [balances, setBalances] = useState<Record<string, bigint>>({});
  const key = tokens.join(',');

  const refresh = useCallback(async () => {
    if (!account || tokens.length === 0) return;
    const owner = account.decodedAddress;
    const entries = await Promise.all(
      tokens.map(async (t) => {
        try {
          const v = vftOf(t);
          if (!v) return [t, 0n] as const;
          const bal = await v.vft.balanceOf(owner).call();
          return [t, BigInt(bal?.toString() ?? '0')] as const;
        } catch {
          return [t, 0n] as const;
        }
      }),
    );
    setBalances(Object.fromEntries(entries));
  }, [account, key, vftOf]);

  useEffect(() => {
    if (!account) { setBalances({}); return; }
    refresh();
    const iv = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
    return () => clearInterval(iv);
  }, [account, refresh]);

  return { balances, refresh };
}

/** Read the wallet's approved allowance to the DEX for each token. */
export function useAllowances(tokens: string[]) {
  const { account } = useAccount();
  const vftOf = useVftFactory();
  const [allowances, setAllowances] = useState<Record<string, bigint>>({});
  const key = tokens.join(',');

  const refresh = useCallback(async () => {
    if (!account || tokens.length === 0) return;
    const owner = account.decodedAddress;
    const entries = await Promise.all(
      tokens.map(async (t) => {
        try {
          const v = vftOf(t);
          if (!v) return [t, 0n] as const;
          const a = await v.vft.allowance(owner, PROGRAM_ID as `0x${string}`).call();
          return [t, BigInt(a?.toString() ?? '0')] as const;
        } catch {
          return [t, 0n] as const;
        }
      }),
    );
    setAllowances(Object.fromEntries(entries));
  }, [account, key, vftOf]);

  useEffect(() => {
    if (!account) { setAllowances({}); return; }
    refresh();
    const iv = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
    return () => clearInterval(iv);
  }, [account, refresh]);

  return { allowances, refresh };
}

/** The perp markets (id, symbol, mark, OI, caps). Polls for the live mark. */
export function usePerpMarkets() {
  const { program, isReady } = useSails();
  const [markets, setMarkets] = useState<PerpMarket[]>([]);
  const refresh = useCallback(async () => {
    if (!program) return;
    try {
      const rows = await program.perpsV1.getMarkets().call();
      setMarkets(Array.isArray(rows) ? rows : []);
    } catch (e) {
      console.error('usePerpMarkets: failed', e);
    }
  }, [program]);
  useEffect(() => {
    if (!isReady) return;
    refresh();
    const iv = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
    return () => clearInterval(iv);
  }, [isReady, refresh]);
  return { markets, refresh };
}

/** The caller's open perp positions as decoded objects, with live PnL. */
export interface PerpPos {
  id: bigint; marketId: bigint; isLong: boolean; notional: bigint;
  entry: bigint; margin: bigint; leverage: number; pnl: bigint;
}
export function usePerpPositions() {
  const { program } = useSails();
  const { account } = useAccount();
  const [positions, setPositions] = useState<PerpPos[]>([]);
  const refresh = useCallback(async () => {
    if (!program || !account) { setPositions([]); return; }
    try {
      const rows = await program.perpsV1.getPositions(account.decodedAddress, 0, 200).call();
      setPositions((Array.isArray(rows) ? rows : []).map((r: any) => ({
        id: BigInt(r[0]), marketId: BigInt(r[1]), isLong: !!r[2], notional: BigInt(r[3]),
        entry: BigInt(r[4]), margin: BigInt(r[5]), leverage: Number(r[6]), pnl: BigInt(r[7]),
      })));
    } catch { /* keep last */ }
  }, [program, account]);
  useEffect(() => {
    if (!account) { setPositions([]); return; }
    refresh();
    const iv = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
    return () => clearInterval(iv);
  }, [account, refresh]);
  return { positions, refresh };
}

/** Read the caller's withdrawable claim balance for each token. */
export function useClaims(tokens: string[]) {
  const { program } = useSails();
  const { account } = useAccount();
  const [claims, setClaims] = useState<Record<string, bigint>>({});
  const key = tokens.join(',');

  const refresh = useCallback(async () => {
    if (!program || !account || tokens.length === 0) return;
    const addr = account.decodedAddress;
    const entries = await Promise.all(
      tokens.map(async (t) => {
        try {
          const c = await program.spot.getClaim(t as `0x${string}`).withAddress(addr).call();
          return [t, BigInt(c?.toString() ?? '0')] as const;
        } catch {
          return [t, 0n] as const;
        }
      }),
    );
    setClaims(Object.fromEntries(entries));
  }, [program, account, key]);

  useEffect(() => {
    if (!program || !account) { setClaims({}); return; }
    refresh();
    const iv = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
    return () => clearInterval(iv);
  }, [program, account, refresh]);

  return { claims, refresh };
}

/** Curated AMM pools, with their live reserves. Polls like the pair list. */
export function useAmmPools() {
  const { program, isReady } = useSails();
  const [pools, setPools] = useState<AmmPool[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!program) return;
    setLoading(true);
    try {
      const rows = await program.amm.getPools(0, 200).call();
      setPools(Array.isArray(rows) ? rows : []);
    } catch (e) {
      console.error('useAmmPools: failed to read pools', e);
    } finally {
      setLoading(false);
    }
  }, [program]);

  useEffect(() => {
    if (!isReady) return;
    refresh();
    const iv = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
    return () => clearInterval(iv);
  }, [isReady, refresh]);

  return { pools, loading, refresh };
}

/** The caller's LP position in a pool: shares, and what they currently redeem for. */
export function useLpPosition(poolId: string | null) {
  const { program } = useSails();
  const { account } = useAccount();
  const [position, setPosition] = useState<{ shares: bigint; amountA: bigint; amountB: bigint }>(
    { shares: 0n, amountA: 0n, amountB: 0n },
  );

  const refresh = useCallback(async () => {
    if (!program || !account || poolId === null) {
      setPosition({ shares: 0n, amountA: 0n, amountB: 0n });
      return;
    }
    try {
      const [shares, amountA, amountB] = await program.amm
        .getPosition(BigInt(poolId))
        .withAddress(account.decodedAddress)
        .call();
      setPosition({ shares: BigInt(shares), amountA: BigInt(amountA), amountB: BigInt(amountB) });
    } catch { /* keep last */ }
  }, [program, account, poolId]);

  useEffect(() => {
    refresh();
    const iv = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
    return () => clearInterval(iv);
  }, [refresh]);

  return { position, refresh };
}
