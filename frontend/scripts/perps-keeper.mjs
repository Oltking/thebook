// Perps mark-price keeper for thebookdex v1 perpetual futures.
//
// Pushes live mark prices on-chain to the PerpsV1 service on a fixed cadence.
// It signs as the perps keeper account, so VARA_SEED must be the account set
// via PerpsV1/SetKeeper (the admin by default). Each tick fetches the live USD
// price of ETH and VARA, converts to micro-USD ($1 = 1e6) as a BigInt, and
// calls PerpsV1/SetMark for each perp market. Micro-USD is fine because perp
// PnL is ratio-based (the unit cancels), we just stay consistent.
//
//   VARA_SEED="<keeper seed>"  node scripts/perps-keeper.mjs
//
// Env auto-loaded from .env.deploy then .env.
//   VARA_SEED            keeper account seed (required)
//   THEBOOK_PROGRAM_ID   perps program id (default: live mainnet program)
//   NODE_ADDRESS         RPC node (default wss://rpc.vara.network)
//   INTERVAL_MS          loop cadence (default 15000)
//
// Perp market ids: 0 = ETH, 1 = VARA (as created on-chain).

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { connectTheBook } from '../../sdk/thebook.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const f of [resolve(__dirname, '..', '.env.deploy'), resolve(__dirname, '..', '.env')]) {
  if (existsSync(f)) { try { process.loadEnvFile(f); } catch { /* ignore */ } }
}
const SEED = process.env.VARA_SEED;
const PROGRAM_ID = process.env.THEBOOK_PROGRAM_ID ?? '0x7c5dbc8a85a8526c3a0c4fe98f0fb286782849c4d130ff28d6b7b30d157c2484';
const NODE_ADDRESS = process.env.NODE_ADDRESS ?? 'wss://rpc.vara.network';
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 15_000);
const fail = (m) => { console.error(`\n  ✗ ${m}\n`); process.exit(1); };
if (!SEED) fail('VARA_SEED is required (the perps keeper seed).');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MICRO = 1_000_000; // on-chain price unit: $1 = 1e6

// ── price sources (keyless) ──
// Binance blocks many cloud IPs with HTTP 451, so each asset tries a chain of
// sources and takes the first that returns a positive price.
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

const ethUsd = () => firstPrice([binance('ETHUSDT'), paprika('eth-ethereum'), coingecko('ethereum')]);
const varaUsd = () => firstPrice([paprika('vara-vara-network'), coingecko('vara-network')]);
const micros = (usd) => BigInt(Math.round(usd * MICRO));

const book = await connectTheBook({ seed: SEED, programId: PROGRAM_ID, node: NODE_ADDRESS });
console.log(`\n  thebookdex perps keeper (mark prices)`);
console.log(`  node:    ${NODE_ADDRESS}`);
console.log(`  keeper:  ${book.address}`);
console.log(`  markets: 0=ETH 1=VARA  ·  loop ${INTERVAL_MS}ms\n`);

async function tick() {
  const [eth, vara] = await Promise.all([ethUsd(), varaUsd()]);
  const pushed = [];
  if (eth > 0) {
    try { await book.perps.setMark(0, micros(eth)); pushed.push(`ETH $${eth}`); }
    catch (e) { console.error(`  ✗ ETH mark push failed: ${e?.message || e}`); }
  } else {
    console.warn('  ⚠ ETH price fetch failed, skipping this tick');
  }
  if (vara > 0) {
    try { await book.perps.setMark(1, micros(vara)); pushed.push(`VARA $${vara}`); }
    catch (e) { console.error(`  ✗ VARA mark push failed: ${e?.message || e}`); }
  } else {
    console.warn('  ⚠ VARA price fetch failed, skipping this tick');
  }
  const marks = pushed.length ? pushed.join('  ') : 'nothing pushed';
  console.log(`  ✓ ${new Date().toISOString()}  marks ${marks}`);
}

let running = true;
process.on('SIGINT', () => { running = false; });
while (running) {
  try { await tick(); } catch (e) { console.error(`  ✗ ${e?.message || e}`); }
  await sleep(INTERVAL_MS);
}
await book.disconnect();
process.exit(0);
