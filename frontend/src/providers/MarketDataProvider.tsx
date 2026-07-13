import { createContext, useContext, useEffect, useState, useCallback, useRef, useMemo, type ReactNode } from 'react';
import { useAccount } from '@gear-js/react-hooks';
import { web3FromSource } from '@polkadot/extension-dapp';
import { useSails } from '../hooks/useSails';
import { toPair, toTradesArray } from '../lib/helpers';

/* ── Types ── */

interface OrderbookData {
  bids: [bigint, bigint][];
  asks: [bigint, bigint][];
}

interface MarketPrices {
  BTC: PriceFeed | null;
  ETH: PriceFeed | null;
  VARA: PriceFeed | null;
}

export interface PricePoint {
  ts: number;
  BTC: number | null;
  ETH: number | null;
  VARA: number | null;
}

const STALE_MS = 5 * 60 * 1000;
const POLL_MS  = 5_000;
const MAX_HISTORY = 200;

interface MarketContextValue {
  prices: MarketPrices;
  orderbooks: Record<string, OrderbookData>;
  trades: Record<string, any[]>;
  pools: Pool[];
  leaders: LeaderEntry[];
  loading: boolean;
  lastFetched: number | null;
  lastFetchedPerAsset: Record<Asset, number | null>;
  pricesStale: boolean;
  pricesStalePer: Record<Asset, boolean>;
  pricesLoading: boolean;
  tickLoading: boolean;
  priceHistory: PricePoint[];
  fetchPrices: () => Promise<void>;
  fetchPrice: (asset: Asset) => Promise<void>;
  refreshAll: () => void;
  tickMarket: () => Promise<void>;
}

/* ── Helpers ── */

const API_URL = '/api/prices';
const ASSETS: Asset[] = ['BTC', 'ETH', 'VARA'];

function defaultPrices(): MarketPrices {
  return { BTC: null, ETH: null, VARA: null };
}

function priceToUsd(feed: PriceFeed | null): number | null {
  if (!feed) return null;
  return Number(feed.price_usd_micro) / 1_000_000;
}

async function fetchBinanceDirect(): Promise<Partial<MarketPrices>> {
  try {
    const res = await fetch(
      'https://api.binance.com/api/v3/ticker/24hr?symbols=%5B%22BTCUSDT%22%2C%22ETHUSDT%22%5D',
      { signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) throw new Error('not ok');
    const rows = await res.json() as Array<{ symbol: string; lastPrice: string; priceChangePercent: string }>;
    const out: Partial<MarketPrices> = {};
    for (const row of rows) {
      const feed: PriceFeed = {
        symbol: row.symbol.replace('USDT', ''),
        price_usd_micro: Math.round(parseFloat(row.lastPrice) * 1_000_000),
        change_24h_bps: Math.round(parseFloat(row.priceChangePercent) * 100),
        market_cap_usd: 0, volume_24h_usd: 0, updated_at_block: 0,
      };
      if (row.symbol === 'BTCUSDT') out.BTC = feed;
      if (row.symbol === 'ETHUSDT') out.ETH = feed;
    }
    return out;
  } catch {
    /* Binance blocked or unavailable — try CoinGecko */
    return fetchCoinGeckoDirect();
  }
}

async function fetchCoinGeckoDirect(): Promise<Partial<MarketPrices>> {
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,vara-network&vs_currencies=usd&include_24hr_change=true',
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) return {};
    const data = await res.json() as Record<string, { usd?: number; usd_24h_change?: number }>;
    const make = (sym: string, usd: number, chg: number): PriceFeed => ({
      symbol: sym,
      price_usd_micro: Math.round(usd * 1_000_000),
      change_24h_bps:  Math.round(chg * 100),
      market_cap_usd: 0, volume_24h_usd: 0, updated_at_block: 0,
    });
    const out: Partial<MarketPrices> = {};
    if (data.bitcoin?.usd)        out.BTC  = make('BTC',  data.bitcoin.usd,        data.bitcoin.usd_24h_change  ?? 0);
    if (data.ethereum?.usd)       out.ETH  = make('ETH',  data.ethereum.usd,       data.ethereum.usd_24h_change ?? 0);
    if (data['vara-network']?.usd) out.VARA = make('VARA', data['vara-network'].usd, data['vara-network'].usd_24h_change ?? 0);
    return out;
  } catch { return {}; }
}

async function loadSharedPrices(): Promise<{ prices: MarketPrices; timestamp: number | null; history: PricePoint[] }> {
  try {
    const res = await fetch(API_URL);
    if (res.ok) {
      const data = await res.json();
      if (data.prices) {
        let p: MarketPrices = data.prices;
        /* If the API returned nulls (cold start), fill in from Binance directly */
        if (!p.BTC || !p.ETH) {
          const direct = await fetchBinanceDirect();
          p = { ...p, ...direct };
        }
        return {
          prices: p,
          timestamp: data.timestamp ?? Date.now(),
          history: Array.isArray(data.history) ? data.history : [],
        };
      }
    }
  } catch {}
  /* API completely unreachable — go direct */
  const direct = await fetchBinanceDirect();
  return {
    prices: { BTC: null, ETH: null, VARA: null, ...direct },
    timestamp: Object.keys(direct).length ? Date.now() : null,
    history: [],
  };
}

async function saveSharedPrices(prices: MarketPrices, ts: number, history: PricePoint[]) {
  try {
    await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prices, timestamp: ts, history }),
    });
  } catch {}
}

/* ── Context ── */

const defaultPerAsset: Record<Asset, number | null> = { BTC: null, ETH: null, VARA: null };
const defaultStalePer: Record<Asset, boolean> = { BTC: false, ETH: false, VARA: false };

const MarketContext = createContext<MarketContextValue>({
  prices: { BTC: null, ETH: null, VARA: null },
  orderbooks: {},
  trades: {},
  pools: [],
  leaders: [],
  loading: true,
  lastFetched: null,
  lastFetchedPerAsset: defaultPerAsset,
  pricesStale: false,
  pricesStalePer: defaultStalePer,
  pricesLoading: false,
  tickLoading: false,
  priceHistory: [],
  fetchPrices: async () => {},
  fetchPrice: async () => {},
  refreshAll: () => {},
  tickMarket: async () => {},
});

export function useMarketData() {
  return useContext(MarketContext);
}

/* ── Provider ── */

export function MarketDataProvider({ children }: { children: ReactNode }) {
  const { account } = useAccount();
  const { program } = useSails();
  const [prices, setPrices] = useState<MarketPrices>(defaultPrices);
  const [orderbooks, setOrderbooks] = useState<Record<string, OrderbookData>>({});
  const [trades, setTrades] = useState<Record<string, any[]>>({});
  const [pools, setPools] = useState<Pool[]>([]);
  const [leaders, setLeaders] = useState<LeaderEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastFetched, setLastFetched] = useState<number | null>(null);
  const [lastFetchedPerAsset, setLastFetchedPerAsset] = useState<Record<Asset, number | null>>(defaultPerAsset);
  const [pricesLoading, setPricesLoading] = useState(false);
  const [tickLoading, setTickLoading] = useState(false);
  const [priceHistory, setPriceHistory] = useState<PricePoint[]>([]);
  const fetchingRef = useRef(false);
  const initLoadedRef = useRef(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pricesRef = useRef(prices);
  const historyRef = useRef(priceHistory);
  pricesRef.current = prices;
  historyRef.current = priceHistory;

  const pricesStale = lastFetched !== null && Date.now() - lastFetched > STALE_MS;
  const pricesStalePer = useMemo<Record<Asset, boolean>>(() => {
    const now = Date.now();
    return {
      BTC:  lastFetchedPerAsset.BTC  !== null && now - lastFetchedPerAsset.BTC  > STALE_MS,
      ETH:  lastFetchedPerAsset.ETH  !== null && now - lastFetchedPerAsset.ETH  > STALE_MS,
      VARA: lastFetchedPerAsset.VARA !== null && now - lastFetchedPerAsset.VARA > STALE_MS,
    };
  }, [lastFetchedPerAsset]);

  /* Load shared prices + history from server on mount */
  useEffect(() => {
    if (initLoadedRef.current) return;
    initLoadedRef.current = true;
    loadSharedPrices().then(({ prices: sp, timestamp, history }) => {
      setPrices(sp);
      const ts = timestamp ?? Date.now();
      setLastFetched(ts);
      setLastFetchedPerAsset({ BTC: ts, ETH: ts, VARA: ts });
      if (history.length) setPriceHistory(history);
    });
  }, []);

  /* Refresh BTC+ETH prices directly from Binance every 60s — no wallet needed */
  useEffect(() => {
    const refresh = async () => {
      const direct = await fetchBinanceDirect();
      if (direct.BTC || direct.ETH) {
        const ts = Date.now();
        setPrices(prev => ({ ...prev, ...direct }));
        setLastFetched(ts);
        setLastFetchedPerAsset(prev => ({
          ...prev,
          ...(direct.BTC ? { BTC: ts } : {}),
          ...(direct.ETH ? { ETH: ts } : {}),
        }));
      }
    };
    const id = setInterval(refresh, 60_000);
    return () => clearInterval(id);
  }, []);

  /* Core market data fetch */
  const fetchAll = useCallback(async (programRef: typeof program) => {
    if (!programRef) return;
    const results = await Promise.allSettled([
      ...ASSETS.map(async (asset) => {
        const [obResult, tradesResult] = await Promise.all([
          programRef.orderbook.getOrderbook(asset).call().catch(() => null),
          programRef.orderbook.getTrades(asset, 20).call().catch(() => null),
        ]);
        return { asset, obResult, tradesResult };
      }),
      programRef.amm.listPools().call().catch(() => []),
      programRef.orderbook.getLeaderboard(10).call().catch(() => []),
    ]);

    const newOrderbooks: Record<string, OrderbookData> = {};
    const newTrades: Record<string, any[]> = {};

    for (let i = 0; i < ASSETS.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled') {
        const { asset, obResult, tradesResult } = r.value as { asset: Asset; obResult: any; tradesResult: any };
        if (obResult != null) {
          const bidsRaw = Array.isArray(obResult) ? obResult[0] : (obResult as any)?.[0];
          const asksRaw = Array.isArray(obResult) ? obResult[1] : (obResult as any)?.[1];
          newOrderbooks[asset] = {
            bids: Array.from(bidsRaw || []).map(toPair),
            asks: Array.from(asksRaw || []).map(toPair),
          };
        } else {
          newOrderbooks[asset] = { bids: [], asks: [] };
        }
        newTrades[asset] = toTradesArray(tradesResult);
      } else {
        newOrderbooks[ASSETS[i]] = { bids: [], asks: [] };
        newTrades[ASSETS[i]] = [];
      }
    }

    setOrderbooks(newOrderbooks);
    setTrades(newTrades);

    const poolsResult = results[3];
    if (poolsResult.status === 'fulfilled') setPools(poolsResult.value as Pool[]);

    const leadersResult = results[4];
    if (leadersResult.status === 'fulfilled') setLeaders(leadersResult.value as LeaderEntry[]);
  }, []);

  /* Initial load + 5s polling (paused while the tab is hidden to save RPC/battery) */
  useEffect(() => {
    if (!program) return;
    let active = true;
    const run = async () => {
      setLoading(true);
      await fetchAll(program);
      if (active) setLoading(false);
    };
    run();
    pollRef.current = setInterval(() => {
      if (active && !document.hidden) fetchAll(program);
    }, POLL_MS);
    /* Catch up immediately when the user returns to the tab */
    const onVisible = () => { if (active && !document.hidden) fetchAll(program); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      if (pollRef.current) clearInterval(pollRef.current);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [program, fetchAll]);

  /* refreshAll: rapid multi-refresh after any tx to catch blockchain latency */
  const refreshAll = useCallback(() => {
    fetchAll(program);
    setTimeout(() => fetchAll(program), 1200);
    setTimeout(() => fetchAll(program), 3000);
    setTimeout(() => fetchAll(program), 6000);
  }, [fetchAll, program]);

  /* ── Helper: append a price snapshot to history ── */
  const appendHistory = useCallback((merged: MarketPrices): PricePoint[] => {
    const point: PricePoint = {
      ts: Date.now(),
      BTC:  priceToUsd(merged.BTC),
      ETH:  priceToUsd(merged.ETH),
      VARA: priceToUsd(merged.VARA),
    };
    const next = [...historyRef.current.slice(-(MAX_HISTORY - 1)), point];
    setPriceHistory(next);
    return next;
  }, []);

  /* ── fetchPrices: refresh all assets from the off-chain market feed ──
     Prices come from Binance/CoinGecko directly, not from any on-chain oracle. */
  const fetchPrices = useCallback(async () => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    setPricesLoading(true);
    try {
      const direct = await fetchBinanceDirect();
      const updatedTs: Partial<Record<Asset, number>> = {};
      const merged: MarketPrices = { ...pricesRef.current };
      const ts = Date.now();
      let changed = false;
      for (const asset of ASSETS) {
        const feed = direct[asset];
        if (feed) { merged[asset] = feed; updatedTs[asset] = ts; changed = true; }
      }
      if (changed) {
        setPrices(merged);
        setLastFetched(ts);
        setLastFetchedPerAsset(prev => ({ ...prev, ...updatedTs }));
        const nextHistory = appendHistory(merged);
        saveSharedPrices(merged, ts, nextHistory);
      }
    } finally {
      fetchingRef.current = false;
      setPricesLoading(false);
    }
  }, [appendHistory]);

  /* Per-asset refresh shares the same off-chain source (feed returns all assets). */
  const fetchPrice = useCallback(async (_asset: Asset) => {
    await fetchPrices();
  }, [fetchPrices]);

  /* ── tickMarket: call Tick() to seed market maker activity ── */
  const tickMarket = useCallback(async () => {
    if (!program || !account || tickLoading) return;
    setTickLoading(true);
    try {
      const { signer } = await web3FromSource(account.meta.source);
      const tx = program.orderbook.tick();
      await tx.withAccount(account.address, { signer }).calculateGas(true, 100);
      const { response } = await tx.signAndSend();
      await response();
      /* Refresh everything after tick */
      await fetchAll(program);
      setTimeout(() => fetchAll(program), 2000);
    } catch (e) {
      console.error('tick() failed:', e);
    } finally {
      setTickLoading(false);
    }
  }, [program, account, fetchAll, tickLoading]);

  return (
    <MarketContext.Provider value={{
      prices,
      orderbooks,
      trades,
      pools,
      leaders,
      loading,
      lastFetched,
      lastFetchedPerAsset,
      pricesStale,
      pricesStalePer,
      pricesLoading,
      tickLoading,
      priceHistory,
      fetchPrices,
      fetchPrice,
      refreshAll,
      tickMarket,
    }}>
      {children}
    </MarketContext.Provider>
  );
}
