import { createContext, useContext, useEffect, useState, useCallback, useRef, useMemo, type ReactNode } from 'react';

/**
 * Off-chain reference prices and a rolling history.
 *
 * This provider is now purely a price feed. It used to also read the legacy
 * virtual-balance services (orderbooks per Asset, AMM pools, the leaderboard, and a
 * `Tick()` write that seeded a synthetic market maker); those services were removed
 * in the audit remediation (C-02), and live book data comes from the `useSpot`
 * hooks against the real CLOB.
 *
 * Prices here are a display and order-sizing reference, not an oracle. Nothing
 * settles against them on chain.
 */

/* ── Types ── */

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
const PRICE_POLL_MS = 4_000;
const MAX_HISTORY = 200;

interface MarketContextValue {
  prices: MarketPrices;
  lastFetched: number | null;
  lastFetchedPerAsset: Record<Asset, number | null>;
  pricesStale: boolean;
  pricesStalePer: Record<Asset, boolean>;
  pricesLoading: boolean;
  priceHistory: PricePoint[];
  fetchPrices: () => Promise<void>;
}

/* ── Helpers ── */

const API_URL = '/api/prices';
const ASSETS: Asset[] = ['BTC', 'ETH', 'VARA'];

function defaultPrices(): MarketPrices {
  return { BTC: null, ETH: null, VARA: null };
}

function feedToUsd(feed: PriceFeed | null): number | null {
  return feed ? Number(feed.price_usd_micro) / 1_000_000 : null;
}

function makeFeed(symbol: string, usd: number, changePct: number): PriceFeed {
  return {
    symbol,
    price_usd_micro: Math.round(usd * 1_000_000),
    change_24h_bps: Math.round(changePct * 100),
    market_cap_usd: 0,
    volume_24h_usd: 0,
    updated_at_block: 0,
  };
}

async function fetchBinanceOnly(): Promise<Partial<MarketPrices>> {
  const res = await fetch(
    'https://api.binance.com/api/v3/ticker/24hr?symbols=%5B%22BTCUSDT%22%2C%22ETHUSDT%22%5D',
    { signal: AbortSignal.timeout(6000) },
  );
  if (!res.ok) throw new Error('not ok');
  const rows = await res.json() as Array<{ symbol: string; lastPrice: string; priceChangePercent: string }>;
  const out: Partial<MarketPrices> = {};
  for (const row of rows) {
    const feed = makeFeed(
      row.symbol.replace('USDT', ''),
      parseFloat(row.lastPrice),
      parseFloat(row.priceChangePercent),
    );
    if (row.symbol === 'BTCUSDT') out.BTC = feed;
    if (row.symbol === 'ETHUSDT') out.ETH = feed;
  }
  return out;
}

async function fetchCoinGeckoDirect(): Promise<Partial<MarketPrices>> {
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,vara-network&vs_currencies=usd&include_24hr_change=true',
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return {};
    const data = await res.json() as Record<string, { usd?: number; usd_24h_change?: number }>;
    const out: Partial<MarketPrices> = {};
    if (data.bitcoin?.usd) out.BTC = makeFeed('BTC', data.bitcoin.usd, data.bitcoin.usd_24h_change ?? 0);
    if (data.ethereum?.usd) out.ETH = makeFeed('ETH', data.ethereum.usd, data.ethereum.usd_24h_change ?? 0);
    if (data['vara-network']?.usd) {
      out.VARA = makeFeed('VARA', data['vara-network'].usd, data['vara-network'].usd_24h_change ?? 0);
    }
    return out;
  } catch { return {}; }
}

/** Fast BTC/ETH path — Binance if reachable, else CoinGecko (which also has VARA). */
async function fetchBinanceDirect(): Promise<Partial<MarketPrices>> {
  try {
    return await fetchBinanceOnly();
  } catch {
    return fetchCoinGeckoDirect();
  }
}

/** VARA-only, resilient: VARA has no Binance pair and CoinGecko rate-limits, so a
 *  single source leaves the ticker showing "-" often enough to matter. */
async function fetchVaraOnly(): Promise<PriceFeed | null> {
  // 1 · CoinPaprika (keyless, CORS-enabled, not aggressively rate-limited).
  try {
    const res = await fetch('https://api.coinpaprika.com/v1/tickers/vara-vara-network', {
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) {
      const d = await res.json() as { quotes?: { USD?: { price?: number; percent_change_24h?: number } } };
      const q = d.quotes?.USD;
      if (q?.price) return makeFeed('VARA', q.price, q.percent_change_24h ?? 0);
    }
  } catch { /* fall through */ }
  // 2 · CoinGecko
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=vara-network&vs_currencies=usd&include_24hr_change=true',
      { signal: AbortSignal.timeout(8_000) },
    );
    if (res.ok) {
      const d = await res.json() as Record<string, { usd?: number; usd_24h_change?: number }>;
      const v = d['vara-network'];
      if (v?.usd) return makeFeed('VARA', v.usd, v.usd_24h_change ?? 0);
    }
  } catch { /* fall through */ }
  // 3 · CryptoCompare
  try {
    const res = await fetch('https://min-api.cryptocompare.com/data/pricemultifull?fsyms=VARA&tsyms=USD', {
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) {
      const d = await res.json() as { RAW?: { VARA?: { USD?: { PRICE?: number; CHANGEPCT24HOUR?: number } } } };
      const raw = d.RAW?.VARA?.USD;
      if (raw?.PRICE) return makeFeed('VARA', raw.PRICE, raw.CHANGEPCT24HOUR ?? 0);
    }
  } catch { /* give up this round */ }
  return null;
}

/** Seed from the server cache, which also carries the shared history. */
async function loadSharedPrices(): Promise<{ prices: MarketPrices; timestamp: number | null; history: PricePoint[] }> {
  try {
    const res = await fetch(API_URL);
    if (res.ok) {
      const data = await res.json();
      if (data.prices) {
        let p: MarketPrices = data.prices;
        if (!p.BTC || !p.ETH) {
          p = { ...p, ...(await fetchBinanceDirect()) };
        }
        return {
          prices: p,
          timestamp: data.timestamp ?? Date.now(),
          history: Array.isArray(data.history) ? data.history : [],
        };
      }
    }
  } catch { /* API unreachable — go direct */ }
  const direct = await fetchBinanceDirect();
  return {
    prices: { ...defaultPrices(), ...direct },
    timestamp: Object.keys(direct).length ? Date.now() : null,
    history: [],
  };
}

/* ── Context ── */

const defaultPerAsset: Record<Asset, number | null> = { BTC: null, ETH: null, VARA: null };
const defaultStalePer: Record<Asset, boolean> = { BTC: false, ETH: false, VARA: false };

const MarketContext = createContext<MarketContextValue>({
  prices: defaultPrices(),
  lastFetched: null,
  lastFetchedPerAsset: defaultPerAsset,
  pricesStale: false,
  pricesStalePer: defaultStalePer,
  pricesLoading: false,
  priceHistory: [],
  fetchPrices: async () => {},
});

export function useMarketData() {
  return useContext(MarketContext);
}

/* ── Provider ── */

export function MarketDataProvider({ children }: { children: ReactNode }) {
  const [prices, setPrices] = useState<MarketPrices>(defaultPrices);
  const [priceHistory, setPriceHistory] = useState<PricePoint[]>([]);
  const [lastFetched, setLastFetched] = useState<number | null>(null);
  const [lastFetchedPerAsset, setLastFetchedPerAsset] = useState<Record<Asset, number | null>>(defaultPerAsset);
  const [pricesLoading, setPricesLoading] = useState(false);
  const initLoadedRef = useRef(false);
  const fetchingRef = useRef(false);

  const pricesStale = lastFetched !== null && Date.now() - lastFetched > STALE_MS;
  const pricesStalePer = useMemo<Record<Asset, boolean>>(() => {
    const now = Date.now();
    return {
      BTC: lastFetchedPerAsset.BTC !== null && now - lastFetchedPerAsset.BTC > STALE_MS,
      ETH: lastFetchedPerAsset.ETH !== null && now - lastFetchedPerAsset.ETH > STALE_MS,
      VARA: lastFetchedPerAsset.VARA !== null && now - lastFetchedPerAsset.VARA > STALE_MS,
    };
  }, [lastFetchedPerAsset]);

  /**
   * Record a sample derived from the state being committed.
   *
   * The previous version read a `prices` snapshot captured *before* the update, so
   * history kept recording the very values the update existed to replace — the null
   * VARA in particular (audit L-12). Taking `next` as an argument removes the
   * possibility of reading a stale snapshot at all.
   */
  const appendHistory = useCallback((next: MarketPrices, ts: number) => {
    setPriceHistory((prev) => {
      const last = prev[prev.length - 1];
      if (last && ts - last.ts < 30_000) return prev;
      const point: PricePoint = {
        ts,
        BTC: feedToUsd(next.BTC),
        ETH: feedToUsd(next.ETH),
        VARA: feedToUsd(next.VARA),
      };
      return [...prev, point].slice(-MAX_HISTORY);
    });
  }, []);

  /** Pull every source once and commit whatever came back. */
  const fetchPrices = useCallback(async () => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    setPricesLoading(true);
    try {
      const [direct, vara] = await Promise.all([fetchBinanceDirect(), fetchVaraOnly()]);
      const merged: Partial<MarketPrices> = { ...direct };
      if (vara) merged.VARA = vara;
      if (!(merged.BTC || merged.ETH || merged.VARA)) return;
      const ts = Date.now();
      // Functional update so only the assets actually fetched are touched: a plain
      // snapshot write here used to clobber VARA back to null every cycle.
      setPrices((prev) => {
        const next = { ...prev };
        for (const asset of ASSETS) {
          const feed = merged[asset];
          if (feed) next[asset] = feed;
        }
        appendHistory(next, ts);
        return next;
      });
      setLastFetched(ts);
      setLastFetchedPerAsset((prev) => ({
        ...prev,
        ...(merged.BTC ? { BTC: ts } : {}),
        ...(merged.ETH ? { ETH: ts } : {}),
        ...(merged.VARA ? { VARA: ts } : {}),
      }));
    } finally {
      fetchingRef.current = false;
      setPricesLoading(false);
    }
  }, [appendHistory]);

  /* Seed from the shared cache once, for instant paint and the longer history. */
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

  /* Poll while the tab is visible; catch up on return. */
  useEffect(() => {
    const refresh = () => { if (!document.hidden) void fetchPrices(); };
    refresh();
    const id = setInterval(refresh, PRICE_POLL_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [fetchPrices]);

  return (
    <MarketContext.Provider value={{
      prices,
      lastFetched,
      lastFetchedPerAsset,
      pricesStale,
      pricesStalePer,
      pricesLoading,
      priceHistory,
      fetchPrices,
    }}>
      {children}
    </MarketContext.Provider>
  );
}
