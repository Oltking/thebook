import type { VercelRequest, VercelResponse } from '@vercel/node';

interface PriceFeed {
  price_usd_micro: string | number;
  change_24h_bps?: string | number;
  symbol?: string;
}

interface Prices {
  BTC: PriceFeed | null;
  ETH: PriceFeed | null;
  VARA: PriceFeed | null;
}

interface PricePoint {
  ts: number;
  BTC: number | null;
  ETH: number | null;
  VARA: number | null;
}

interface CacheEntry {
  prices: Prices;
  timestamp: number;
  history: PricePoint[];
}

const MAX_HISTORY = 200;
const LIVE_TTL = 60 * 1000;       // 1-min live cache
const VARA_TTL = 3 * 60 * 1000;   // 3-min for VARA (CoinGecko slower)

// Module-scope caches are per serverless instance, not shared: they only ever
// reduce upstream calls within one warm instance, and KV is the cross-instance
// store. Do not treat them as a source of truth (audit L-10).
let memCache: CacheEntry = { prices: { BTC: null, ETH: null, VARA: null }, timestamp: 0, history: [] };
let liveCache: { prices: Prices; ts: number } | null = null;
let varaCache: { feed: PriceFeed; ts: number } | null = null;

/* ── Vercel KV ── */

async function kvGet(): Promise<CacheEntry | null> {
  try {
    const url = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;
    if (!url || !token) return null;
    const res = await fetch(`${url}/get/thebookdex:prices`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const json = await res.json() as { result?: string | null };
    if (!json.result) return null;
    return JSON.parse(json.result) as CacheEntry;
  } catch { return null; }
}

async function kvSet(entry: CacheEntry): Promise<void> {
  try {
    const url = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;
    if (!url || !token) return;
    await fetch(`${url}/set/thebookdex:prices`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: JSON.stringify(entry), ex: 86400 }),
    });
  } catch { /* ignore */ }
}

/* ── Binance (BTC + ETH) ── */

async function fetchBinance(): Promise<{ BTC: PriceFeed | null; ETH: PriceFeed | null }> {
  try {
    const res = await fetch(
      'https://api.binance.com/api/v3/ticker/24hr?symbols=%5B%22BTCUSDT%22%2C%22ETHUSDT%22%5D',
      { headers: { Accept: 'application/json' } }
    );
    if (!res.ok) return { BTC: null, ETH: null };
    const data = await res.json() as Array<{ symbol: string; lastPrice: string; priceChangePercent: string }>;
    const btcRow = data.find(d => d.symbol === 'BTCUSDT');
    const ethRow = data.find(d => d.symbol === 'ETHUSDT');
    return {
      BTC: btcRow ? {
        symbol: 'BTC',
        price_usd_micro: Math.round(parseFloat(btcRow.lastPrice) * 1_000_000),
        change_24h_bps: Math.round(parseFloat(btcRow.priceChangePercent) * 100),
      } : null,
      ETH: ethRow ? {
        symbol: 'ETH',
        price_usd_micro: Math.round(parseFloat(ethRow.lastPrice) * 1_000_000),
        change_24h_bps: Math.round(parseFloat(ethRow.priceChangePercent) * 100),
      } : null,
    };
  } catch { return { BTC: null, ETH: null }; }
}

/* ── CoinGecko (VARA only) ── */

async function fetchVara(): Promise<PriceFeed | null> {
  try {
    if (varaCache && Date.now() - varaCache.ts < VARA_TTL) return varaCache.feed;
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=vara-network&vs_currencies=usd&include_24hr_change=true',
      { headers: { Accept: 'application/json' } }
    );
    if (!res.ok) return null;
    const data = await res.json() as Record<string, { usd?: number; usd_24h_change?: number }>;
    const v = data['vara-network'];
    if (!v?.usd) return null;
    const feed: PriceFeed = {
      symbol: 'VARA',
      price_usd_micro: Math.round(v.usd * 1_000_000),
      change_24h_bps: Math.round((v.usd_24h_change ?? 0) * 100),
    };
    varaCache = { feed, ts: Date.now() };
    return feed;
  } catch { return null; }
}

async function fetchLivePrices(): Promise<Prices | null> {
  if (liveCache && Date.now() - liveCache.ts < LIVE_TTL) return liveCache.prices;
  const [binance, vara] = await Promise.all([fetchBinance(), fetchVara()]);
  if (!binance.BTC && !binance.ETH && !vara) return null;
  const prices: Prices = { BTC: binance.BTC, ETH: binance.ETH, VARA: vara };
  liveCache = { prices, ts: Date.now() };
  return prices;
}

function hasAnyPrice(prices: Prices): boolean {
  return prices.BTC !== null || prices.ETH !== null || prices.VARA !== null;
}

/* ── Handler ── */

/** Append a live sample to the rolling history, keeping it bounded. */
function appendPoint(history: PricePoint[], prices: Prices, ts: number): PricePoint[] {
  const micro = (f: PriceFeed | null) => (f ? Number(f.price_usd_micro) / 1_000_000 : null);
  const point: PricePoint = { ts, BTC: micro(prices.BTC), ETH: micro(prices.ETH), VARA: micro(prices.VARA) };
  // One sample per minute is plenty; drop anything closer than that.
  const last = history[history.length - 1];
  if (last && ts - last.ts < 60_000) return history;
  return [...history, point].slice(-MAX_HISTORY);
}

/**
 * Read-only price feed.
 *
 * There is deliberately no write path. The POST branch that used to exist wrote
 * caller-supplied prices and a caller-supplied 200-point history straight into the
 * shared cache with no authentication, and that cache is served to every visitor
 * whenever the live feeds are down — so anyone could push arbitrary prices to all
 * users, including the reference price the order form sizes against (audit H-06).
 * The GET path fetches live prices and maintains the cache and history itself, so
 * nothing was lost by removing it.
 *
 * CORS is restricted to the app's own origin (audit M-16 applies the same rule to
 * every function here).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const allowed = (process.env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const origin = String(req.headers.origin || '');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  const originOk = origin ? allowed.includes(origin) : true;
  if (origin && originOk) res.setHeader('Access-Control-Allow-Origin', origin);

  if (req.method === 'OPTIONS') { res.status(originOk ? 200 : 403).end(); return; }
  if (!originOk) { res.status(403).json({ error: 'origin not allowed' }); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'GET only' }); return; }

  /* Always try live prices first. */
  const live = await fetchLivePrices();
  if (live && hasAnyPrice(live)) {
    const now = Date.now();
    const kvEntry = await kvGet();
    const history = appendPoint(kvEntry?.history ?? memCache.history, live, now);
    const entry: CacheEntry = { prices: live, timestamp: now, history };
    memCache = entry;
    await kvSet(entry);
    res.status(200).json(entry);
    return;
  }

  /* Live feeds unavailable — fall back to KV / memCache. */
  let entry: CacheEntry | null = await kvGet();
  if (!entry || !hasAnyPrice(entry.prices)) {
    if (hasAnyPrice(memCache.prices)) entry = memCache;
  }
  res.status(200).json({
    prices:    entry?.prices    ?? { BTC: null, ETH: null, VARA: null },
    timestamp: entry?.timestamp ?? null,
    history:   entry?.history   ?? [],
  });
}
