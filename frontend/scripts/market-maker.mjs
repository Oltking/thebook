// House market maker for thebookdex.
//
// The house (DEX admin) claims its one-time deep stockpile (`seed_house`) and then
// continuously posts two-sided limit orders around the keeper mark, so USDT-only
// agents always have a counterparty (buy: fills the house asks; sell: fills the
// house bids). Run it alongside the keeper.
//
//   VARA_SEED="<admin seed>"                  \   # MUST be the DEX admin (deployer)
//   PROGRAM_ID=0x…                            \   # the DEX program id
//   NODE_ADDRESS=wss://testnet.vara.network   \
//   node scripts/market-maker.mjs
//
// Env is auto-loaded from .env.deploy then .env. INTERVAL_MS (default 15000)
// controls the requote cadence.
//
// Prices are micro-dollars ($1 = 1e6) on-chain, so BTC, ETH and VARA all quote
// cleanly; ASSETS defaults to all three.

import { readFileSync, existsSync } from 'node:fs';
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
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 15_000);
const ASSETS = (process.env.ASSETS ?? 'BTC,ETH,VARA').split(',').map((s) => s.trim().toUpperCase());
const MICRO = 1_000_000; // on-chain price unit: $1 = 1e6
const fail = (m) => { console.error(`\n  ✗ ${m}\n`); process.exit(1); };
if (!SEED) fail('VARA_SEED is required (the DEX admin / deployer seed).');
if (!PROGRAM_ID) fail('PROGRAM_ID is required.');

// Ladder: (tick offset from mark, size in whole asset) for each side.
// Each level is (spread in basis points from mid, size in whole assets). Micro-dollar
// prices make a raw "+1 tick" negligible, so we step by a fraction of price instead.
const LADDER = [
  { bps: 5, size: 2 },
  { bps: 15, size: 4 },
  { bps: 30, size: 8 },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const book = await connectTheBook({ seed: SEED, programId: PROGRAM_ID, node: NODE_ADDRESS });
console.log(`\n  thebookdex market maker`);
console.log(`  ───────────────────────`);
console.log(`  node:   ${NODE_ADDRESS}`);
console.log(`  house:  ${book.address}`);
console.log(`  assets: ${ASSETS.join(', ')}  ·  requote ${INTERVAL_MS}ms\n`);

// One-time setup: join (USDT) + claim the house stockpile (idempotent on-chain).
await book.join('House', Strategy.MarketMaker);
try {
  const bal = await book.seedHouse();
  console.log('  house stockpile:', bal);
} catch (e) {
  console.warn('  seed_house skipped:', e?.message || e);
}

async function requote() {
  const marks = await book.marks(); // { btc, eth, vara } in USD
  // Clear our existing orders so we don't stack stale levels.
  const mine = await book.myOrders().catch(() => []);
  for (const o of Array.isArray(mine) ? mine : []) {
    try { await book.cancelOrder(o[0]); } catch { /* already gone */ }
  }
  for (const a of ASSETS) {
    const usd = marks[a.toLowerCase()];
    if (!usd || usd <= 0) { console.log(`  · ${a}: no mark, skip`); continue; }
    const mid = Math.max(1, Math.round(usd * MICRO)); // price in micro-dollars
    for (const { bps, size } of LADDER) {
      const spread = Math.max(1, Math.round((mid * bps) / 10_000));
      // Asks above the mark, bids below — the house makes the market both ways.
      try { await book.placeLimit(Side.Sell, Asset[a], mid + spread, book.qty(size)); } catch (e) { console.warn(`  ask ${a} ${mid + spread}: ${e?.message || e}`); }
      const bidPx = mid - spread;
      if (bidPx >= 1) {
        try { await book.placeLimit(Side.Buy, Asset[a], bidPx, book.qty(size)); } catch (e) { console.warn(`  bid ${a} ${bidPx}: ${e?.message || e}`); }
      }
    }
    console.log(`  ✓ ${a} quoted around $${usd.toLocaleString()} (mid ${mid} µ$)`);
  }
}

let running = true;
process.on('SIGINT', () => { running = false; });
while (running) {
  try { await requote(); }
  catch (e) { console.error(`  ✗ requote failed: ${e?.message || e}`); }
  await sleep(INTERVAL_MS);
}
await book.disconnect();
process.exit(0);
