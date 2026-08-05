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
// NOTE on precision: the book price unit is $1000/tick, which quotes BTC fine but
// is too coarse for ETH/VARA. Set ASSETS=BTC (default) until finer tick precision
// lands; pass ASSETS=BTC,ETH,VARA to quote all three anyway.

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
const ASSETS = (process.env.ASSETS ?? 'BTC').split(',').map((s) => s.trim().toUpperCase());
const fail = (m) => { console.error(`\n  ✗ ${m}\n`); process.exit(1); };
if (!SEED) fail('VARA_SEED is required (the DEX admin / deployer seed).');
if (!PROGRAM_ID) fail('PROGRAM_ID is required.');

// Ladder: (tick offset from mark, size in whole asset) for each side.
const LADDER = [
  { off: 0, size: 2 },
  { off: 1, size: 4 },
  { off: 2, size: 8 },
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
    const tick = Math.max(1, Math.round(usd / 1000)); // book price unit = $1000/tick
    for (const { off, size } of LADDER) {
      // Asks at/above the mark, bids below — the house makes the market both ways.
      try { await book.placeLimit(Side.Sell, Asset[a], tick + off, book.qty(size)); } catch (e) { console.warn(`  ask ${a} ${tick + off}: ${e?.message || e}`); }
      const bidTick = tick - 1 - off;
      if (bidTick >= 1) {
        try { await book.placeLimit(Side.Buy, Asset[a], bidTick, book.qty(size)); } catch (e) { console.warn(`  bid ${a} ${bidTick}: ${e?.message || e}`); }
      }
    }
    console.log(`  ✓ ${a} quoted around $${usd.toLocaleString()} (tick ${tick})`);
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
