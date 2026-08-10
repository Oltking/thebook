// Combined house market runner for thebookdex — ONE process, ONE signer.
//
// Both the mark-price keeper (Perps.SetMarkPrices) and the house market maker
// (place/cancel orders) are admin-only, so they must sign as the same account.
// Running them as two processes collides on the nonce ("Priority is too low"), so
// this single loop does both sequentially: fetch prices → push marks → requote.
//
//   VARA_SEED="<admin seed>"  PROGRAM_ID=0x…  node scripts/market-runner.mjs
//
// Env auto-loaded from .env.deploy then .env. INTERVAL_MS default 10000.
// Prices are micro-dollars ($1 = 1e6) on-chain, so BTC, ETH and VARA all quote
// cleanly — ASSETS defaults to all three.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { connectTheBook, Asset, Side, Strategy } from '../../sdk/thebook.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const f of [resolve(__dirname, '..', '.env.deploy'), resolve(__dirname, '..', '.env')]) {
  if (existsSync(f)) { try { process.loadEnvFile(f); } catch { /* ignore */ } }
}
const SEED = process.env.VARA_SEED;
const PROGRAM_ID = process.env.PROGRAM_ID ?? process.env.VITE_PROGRAM_ID;
const NODE_ADDRESS = process.env.NODE_ADDRESS ?? 'wss://testnet.vara.network';
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 10_000);
const ASSETS = (process.env.ASSETS ?? 'BTC,ETH,VARA').split(',').map((s) => s.trim().toUpperCase());
const fail = (m) => { console.error(`\n  ✗ ${m}\n`); process.exit(1); };
if (!SEED) fail('VARA_SEED is required (the DEX admin seed).');
if (!PROGRAM_ID) fail('PROGRAM_ID is required.');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Ladder: three levels, each a spread (basis points from mid) and a per-asset size in
// whole units. Micro-dollar prices make a raw "+1 tick" negligible, so we step by a
// fraction of price (bps). Sizes are scaled per asset so every book gets meaningful,
// roughly balanced depth — a fixed "2/4/8 units" would be ~$900k of BTC but a few
// tenths of a cent of VARA. VARA sizes stay within the house's ~1M VARA stockpile.
const MICRO = 1_000_000; // on-chain price unit: $1 = 1e6
const ASSET_UNIT = 100_000; // on-chain qty unit: 1 whole asset = 1e5
const BPS = [5, 15, 30];
const SIZES = {
  BTC: [0.02, 0.04, 0.08],        // ~$1.3k / $2.6k / $5.1k per level
  ETH: [0.5, 1, 2],               // ~$950 / $1.9k / $3.8k
  VARA: [50_000, 100_000, 200_000], // ~$20 / $40 / $80 (house holds ~1M VARA)
};
const LADDER = BPS.map((bps, i) => ({ bps, i }));

// ── price sources (keyless) ──
// Binance blocks many cloud IPs (Render, etc.) with HTTP 451, so BTC/ETH must have
// non-Binance fallbacks or their marks/quotes silently drop to 0. Each asset tries a
// chain of sources and takes the first that returns a positive price.
const asFloat = (v) => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : 0; };
async function firstPrice(sources) {
  for (const src of sources) {
    try { const p = await src(); if (p > 0) return p; } catch { /* try next */ }
  }
  return 0;
}
const binance = (sym) => async () => {
  const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}`);
  return asFloat((await r.json())?.price);
};
const paprika = (id) => async () => {
  const r = await fetch(`https://api.coinpaprika.com/v1/tickers/${id}`);
  return asFloat((await r.json())?.quotes?.USD?.price);
};
const coingecko = (id) => async () => {
  const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
  return asFloat((await r.json())?.[id]?.usd);
};

async function usdPrices() {
  const [btc, eth, vara] = await Promise.all([
    firstPrice([binance('BTCUSDT'), paprika('btc-bitcoin'), coingecko('bitcoin')]),
    firstPrice([binance('ETHUSDT'), paprika('eth-ethereum'), coingecko('ethereum')]),
    firstPrice([paprika('vara-vara-network'), coingecko('vara-network')]),
  ]);
  return { btc, eth, vara };
}
const micros = (usd) => Math.round(usd * MICRO);

const book = await connectTheBook({ seed: SEED, programId: PROGRAM_ID, node: NODE_ADDRESS });
console.log(`\n  thebookdex market runner (marks + house quotes)`);
console.log(`  node:   ${NODE_ADDRESS}`);
console.log(`  house:  ${book.address}`);
console.log(`  assets: ${ASSETS.join(', ')}  ·  loop ${INTERVAL_MS}ms\n`);

await book.join('House', Strategy.MarketMaker);
try { console.log('  house stockpile:', await book.seedHouse()); }
catch (e) { console.warn('  seed_house skipped:', e?.message || e); }

// Only requote an asset when its mark moves past this fraction, so a quiet market
// costs ~1 tx/loop (just the mark push) instead of a full cancel+repost every loop.
// Cutting the transaction rate is what keeps us under the testnet's nonce/pool limits.
const REQUOTE_BPS = Number(process.env.REQUOTE_BPS ?? 20); // 0.20%
const lastMid = {}; // asset -> micro mid we last quoted around

// Submit many calls in one shot with EXPLICIT sequential nonces (base, base+1, …).
// Awaiting `response()` per tx doesn't stop bursts from colliding (the account nonce
// isn't pool-aware between rapid sends → "Priority is too low" / "Transaction is
// outdated"). Pinning each tx to its own nonce, fetched once, is collision-proof for a
// single signer. Calls execute in nonce order, so cancels (added first) run before the
// re-posts that reuse the freed balance. Returns {ok, fail, firstErr}.
async function submitBatch(calls) {
  if (calls.length === 0) return { ok: 0, fail: 0, firstErr: null };
  const base = (await book.api.rpc.system.accountNextIndex(book.address)).toNumber();
  const results = await Promise.allSettled(calls.map(async (c, i) => {
    const tx = book.sails.services[c.service].functions[c.fn](...c.args);
    tx.withAccount(book.account, { nonce: base + i });
    await tx.calculateGas(true);
    const { response } = await tx.signAndSend();
    const v = await response();
    if (v && typeof v === 'object' && 'err' in v) throw new Error(JSON.stringify(v.err));
    return v;
  }));
  let ok = 0, fail = 0, firstErr = null;
  for (const r of results) {
    if (r.status === 'fulfilled') ok++;
    else { fail++; if (!firstErr) firstErr = r.reason?.message || String(r.reason); }
  }
  return { ok, fail, firstErr };
}

async function tick() {
  const p = await usdPrices();
  const mine = await book.myOrders().catch(() => []);
  const orders = Array.isArray(mine) ? mine : [];
  // House balances, to clamp what the mark-cross keeper can take (whole units).
  const port = await book.portfolio().catch(() => ({ usd: 0, btc: 0, eth: 0, vara: 0 }));

  // Build one batch: the mark push, then per-asset (mark-cross sweep + cancel+repost)
  // for assets that moved, are thin, or have user orders the mark just crossed.
  // Everything shares one contiguous nonce range and executes in push order.
  const calls = [{ service: 'Perps', fn: 'SetMarkPrices', args: [micros(p.btc), micros(p.eth), micros(p.vara)] }];
  const requoted = [];
  const swept = [];
  for (const a of ASSETS) {
    const usd = p[a.toLowerCase()];
    if (!usd || usd <= 0) continue;
    const mid = micros(usd);
    // o = (id, side, asset, price, qty, filled, status)
    const own = orders.filter((o) => String(o[2]) === a);
    const prev = lastMid[a];
    const moved = !prev || Math.abs(mid - prev) / prev > REQUOTE_BPS / 10_000;

    // ── mark-cross keeper ────────────────────────────────────────────────
    // A resting spot limit only fills when a counterparty crosses it; the mark
    // ticking through its price is not a trade. So the house acts as taker of
    // last resort: any USER order the mark has crossed (a buy at/above the new
    // mark, a sell at/below it) gets filled by the house at the user's own
    // limit price — because a crossed fill settles at the resting order's price.
    // We fill only the user portion: the house's own resting orders are cancelled
    // in the requote below, so sizing the sweep to (book crossed − own crossed)
    // leaves exactly the user depth for the house's single crossing order to take.
    const rem = (o) => Number(o[4]) - Number(o[5]);
    const ownBuyX = own.filter((o) => String(o[1]) === 'Buy' && Number(o[3]) >= mid).reduce((s, o) => s + rem(o), 0);
    const ownSellX = own.filter((o) => String(o[1]) === 'Sell' && Number(o[3]) <= mid).reduce((s, o) => s + rem(o), 0);
    const ob = await book.orderbook(a).catch(() => ({ bids: [], asks: [] }));
    const bookBuyX = ob.bids.filter((l) => l.price >= mid).reduce((s, l) => s + l.qty, 0);
    const bookSellX = ob.asks.filter((l) => l.price <= mid).reduce((s, l) => s + l.qty, 0);
    const assetRaw = Math.floor(Number(port[a.toLowerCase()] || 0) * ASSET_UNIT); // house asset to sell
    const usdRaw = Math.floor(Number(port.usd || 0) * MICRO); // house usd to buy
    const userBuyX = Math.min(Math.max(0, bookBuyX - ownBuyX), assetRaw); // house SELLS to these buyers
    const usdBuyCap = Math.floor((usdRaw / mid) * ASSET_UNIT); // asset units the house's usd can buy at mid
    const userSellX = Math.min(Math.max(0, bookSellX - ownSellX), usdBuyCap); // house BUYS from these sellers
    const needSweep = userBuyX > 0 || userSellX > 0;

    // Refill when the mark moved, the ladder is thin (a fill swept part of it), or
    // there are user orders to sweep. Otherwise leave the resting ladder alone.
    const full = own.length >= 2 * LADDER.length;
    if (full && !moved && !needSweep) continue;

    // Cancel the house's own resting orders first, so the crossing sweep below
    // only reaches user orders (not the house trading with itself).
    for (const o of own) calls.push({ service: 'Orderbook', fn: 'CancelOrder', args: [o[0]] });

    if (userBuyX > 0) {
      calls.push({ service: 'Orderbook', fn: 'PlaceLimit', args: [Side.Sell, Asset[a], mid, userBuyX] });
      swept.push(`${a} sell ${userBuyX}`);
    }
    if (userSellX > 0) {
      calls.push({ service: 'Orderbook', fn: 'PlaceLimit', args: [Side.Buy, Asset[a], mid, userSellX] });
      swept.push(`${a} buy ${userSellX}`);
    }

    const sizes = SIZES[a] || [1, 2, 4];
    for (const { bps, i } of LADDER) {
      const qty = book.qty(sizes[i]);
      const spread = Math.max(1, Math.round((mid * bps) / 10_000));
      calls.push({ service: 'Orderbook', fn: 'PlaceLimit', args: [Side.Sell, Asset[a], mid + spread, qty] });
      const bid = mid - spread;
      if (bid >= 1) calls.push({ service: 'Orderbook', fn: 'PlaceLimit', args: [Side.Buy, Asset[a], bid, qty] });
    }
    lastMid[a] = mid;
    requoted.push(a);
  }

  const { ok, fail, firstErr } = await submitBatch(calls);
  const rq = requoted.length ? `requoted ${requoted.join(',')}` : 'quotes steady';
  const sw = swept.length ? `  ·  crossed ${swept.join(', ')}` : '';
  const errNote = fail ? `  ✗ ${fail} failed (${firstErr})` : '';
  console.log(`  ✓ ${new Date().toISOString()}  marks BTC $${Math.round(p.btc)} ETH $${Math.round(p.eth)} VARA $${p.vara}  ·  ${rq}${sw}  ·  ${ok}/${calls.length} tx ok${errNote}`);
}

let running = true;
process.on('SIGINT', () => { running = false; });
while (running) {
  try { await tick(); } catch (e) { console.error(`  ✗ ${e?.message || e}`); }
  await sleep(INTERVAL_MS);
}
await book.disconnect();
process.exit(0);
