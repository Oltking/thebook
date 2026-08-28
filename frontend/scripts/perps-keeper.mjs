// Perps mark-price keeper for thebookdex v1 perpetual futures.
//
// Pushes live mark prices on-chain to the PerpsV1 service on a fixed cadence.
// It signs as the perps keeper account, so KEEPER_SEED must be the account set
// via PerpsV1/SetKeeper (the admin by default). Each tick fetches the live USD
// price of ETH and VARA, converts to micro-USD ($1 = 1e6) as a BigInt, and
// calls PerpsV1/SetMark for each perp market. Micro-USD is fine because perp
// PnL is ratio-based (the unit cancels), we just stay consistent.
//
//   KEEPER_SEED="<keeper seed>"  node scripts/perps-keeper.mjs
//
// Env auto-loaded from .env.deploy then .env.
//   KEEPER_SEED          keeper account seed (required). Must be a dedicated key
//                        with NO admin rights: the contract no longer accepts the
//                        admin as an implicit keeper (audit H-04, H-09).
//   THEBOOK_PROGRAM_ID   perps program id (default: live mainnet program)
//   NODE_ADDRESS         RPC node (default wss://rpc.vara.network)
//   INTERVAL_MS          loop cadence (default 15000)
//
// Perp market ids: 0 = ETH, 1 = VARA (as created on-chain).

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { connectTheBook } from '../../sdk/thebook.mjs';
import { requireNode } from './lib/env.mjs';

// Captured before any dotfile is loaded: an explicitly-passed NODE_ADDRESS must
// win, so a stale value in frontend/.env cannot redirect a signed action to the
// wrong chain (audit H-09).
const CLI_NODE = process.env.NODE_ADDRESS;

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const f of [resolve(__dirname, '..', '.env.deploy'), resolve(__dirname, '..', '.env')]) {
  if (existsSync(f)) { try { process.loadEnvFile(f); } catch { /* ignore */ } }
}
// VARA_SEED is accepted only as a legacy fallback and warned about: the keeper
// must not be the admin key.
const SEED = process.env.KEEPER_SEED ?? process.env.VARA_SEED;
if (!process.env.KEEPER_SEED && process.env.VARA_SEED) {
  console.warn('  ! Using VARA_SEED. Set KEEPER_SEED to a dedicated keeper key with no admin rights (audit H-09).');
}
const PROGRAM_ID = process.env.THEBOOK_PROGRAM_ID ?? '0xe7540b7c404234b4345720a43138f58ba4af7de9367ff8fd2b4428586daf66a3';
// Required, no default: this script signs (audit H-09).
const NODE_ADDRESS = requireNode({ cliNode: CLI_NODE });
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 15_000);
const fail = (m) => { console.error(`\n  ✗ ${m}\n`); process.exit(1); };
if (!SEED) fail('KEEPER_SEED is required (a dedicated perps keeper seed, not the admin).');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// On-chain mark unit: $1 = 1e12 (pico-USD).
//
// The contract treats the unit as arbitrary because PnL is a ratio, so this only has
// to be consistent. It must also be FINE ENOUGH. At micro-USD ($1 = 1e6), VARA at
// $0.00042 becomes the integer 421: three significant figures, where a 0.1% real
// move rounds away to nothing and the mark moves in 0.24% steps. Pico-USD gives
// VARA nine significant figures and still leaves ETH (~2.4e15) far inside u128.
//
// Changing this unit on a market that already holds positions would corrupt their
// PnL, since `entry` was recorded in the old unit. Only safe while marks are 0.
const PRICE_UNIT = 1_000_000_000_000n;

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
/** USD float to the on-chain integer unit, without losing small prices to rounding. */
const toMark = (usd) => {
  // Via string to avoid float error at 12 decimal places.
  const [whole, frac = ''] = usd.toFixed(12).split('.');
  return BigInt(whole) * PRICE_UNIT + BigInt(frac.padEnd(12, '0').slice(0, 12));
};

const book = await connectTheBook({ seed: SEED, programId: PROGRAM_ID, node: NODE_ADDRESS });
console.log(`\n  thebookdex perps keeper (mark prices)`);
console.log(`  node:    ${NODE_ADDRESS}`);
console.log(`  keeper:  ${book.address}`);
console.log(`  markets: 0=ETH 1=VARA  ·  loop ${INTERVAL_MS}ms\n`);

/** Largest single move the contract accepts, in basis points (MAX_MARK_DEVIATION_BPS). */
const MAX_STEP_BPS = 1000n;
/** Stay just inside the bound so rounding cannot push a step over it. */
const SAFE_STEP_BPS = 900n;

/**
 * The next mark to publish, stepping toward `target` if it is too far from `current`.
 *
 * The contract rejects any single update deviating more than 10% from the previous
 * mark. That protects against a compromised keeper, but it also means a keeper that
 * was down while the price moved 15% would have every push rejected — and since the
 * mark never updates, it would stay rejected. Stepping converges over a few ticks
 * instead of stalling.
 *
 * A mark of 0, or one stale past the contract's exit window, bootstraps: any price
 * is accepted, so jump straight to the target.
 */
function nextMark(current, target) {
  if (current === 0n) return target;
  const diff = target > current ? target - current : current - target;
  const limit = (current * SAFE_STEP_BPS) / 10_000n;
  if (diff <= limit) return target;
  return target > current ? current + limit : current - limit;
}

async function pushMark(marketId, label, usd, markets) {
  if (usd <= 0) {
    console.warn(`  ⚠ ${label} price fetch failed, skipping this tick`);
    return null;
  }
  const target = toMark(usd);
  const current = BigInt(markets.find((m) => String(m.id) === String(marketId))?.mark ?? 0);
  const next = nextMark(current, target);
  try {
    await book.perps.setMark(marketId, next);
    const stepping = next !== target ? ' (stepping)' : '';
    return `${label} $${usd}${stepping}`;
  } catch (e) {
    console.error(`  ✗ ${label} mark push failed: ${e?.message || e}`);
    return null;
  }
}

async function tick() {
  // Read current marks so a step can be computed against what is actually on chain.
  const markets = await book.perps.markets();
  const [eth, vara] = await Promise.all([ethUsd(), varaUsd()]);
  const pushed = (await Promise.all([
    pushMark(0, 'ETH', eth, markets),
    pushMark(1, 'VARA', vara, markets),
  ])).filter(Boolean);
  console.log(`  ✓ ${new Date().toISOString()}  marks ${pushed.length ? pushed.join('  ') : 'nothing pushed'}`);
}

let running = true;
process.on('SIGINT', () => { running = false; });
while (running) {
  try { await tick(); } catch (e) { console.error(`  ✗ ${e?.message || e}`); }
  await sleep(INTERVAL_MS);
}
await book.disconnect();
process.exit(0);
