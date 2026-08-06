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
// Ladder levels: each is (spread in basis points from mid, size in whole assets).
// Micro-dollar prices mean a raw "+1 tick" is $0.000001 — far too tight — so we
// step by a fraction of the price (bps) instead, which works for BTC and VARA alike.
const LADDER = [{ bps: 5, size: 2 }, { bps: 15, size: 4 }, { bps: 30, size: 8 }];
const MICRO = 1_000_000; // on-chain price unit: $1 = 1e6

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

  // Build one batch: the mark push, then per-asset cancel+repost for assets that moved
  // (or have no resting orders yet). Everything shares one contiguous nonce range.
  const calls = [{ service: 'Perps', fn: 'SetMarkPrices', args: [micros(p.btc), micros(p.eth), micros(p.vara)] }];
  const requoted = [];
  for (const a of ASSETS) {
    const usd = p[a.toLowerCase()];
    if (!usd || usd <= 0) continue;
    const mid = micros(usd);
    const own = orders.filter((o) => String(o[2]) === a); // o[2] = asset
    const prev = lastMid[a];
    const moved = !prev || Math.abs(mid - prev) / prev > REQUOTE_BPS / 10_000;
    if (own.length > 0 && !moved) continue; // ladder still good — leave it resting

    for (const o of own) calls.push({ service: 'Orderbook', fn: 'CancelOrder', args: [o[0]] });
    for (const { bps, size } of LADDER) {
      const spread = Math.max(1, Math.round((mid * bps) / 10_000));
      calls.push({ service: 'Orderbook', fn: 'PlaceLimit', args: [Side.Sell, Asset[a], mid + spread, book.qty(size)] });
      const bid = mid - spread;
      if (bid >= 1) calls.push({ service: 'Orderbook', fn: 'PlaceLimit', args: [Side.Buy, Asset[a], bid, book.qty(size)] });
    }
    lastMid[a] = mid;
    requoted.push(a);
  }

  const { ok, fail, firstErr } = await submitBatch(calls);
  const rq = requoted.length ? `requoted ${requoted.join(',')}` : 'quotes steady';
  const errNote = fail ? `  ✗ ${fail} failed (${firstErr})` : '';
  console.log(`  ✓ ${new Date().toISOString()}  marks BTC $${Math.round(p.btc)} ETH $${Math.round(p.eth)} VARA $${p.vara}  ·  ${rq}  ·  ${ok}/${calls.length} tx ok${errNote}`);
}

let running = true;
process.on('SIGINT', () => { running = false; });
while (running) {
  try { await tick(); } catch (e) { console.error(`  ✗ ${e?.message || e}`); }
  await sleep(INTERVAL_MS);
}
await book.disconnect();
process.exit(0);
