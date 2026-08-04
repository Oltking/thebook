// Price keeper for thebookdex perpetual futures.
//
// Real perps settle PnL and liquidations at an on-chain "mark price". This keeper
// pulls live prices (Binance, with a CoinGecko fallback for VARA) and pushes them
// on-chain via `Perps/SetMarkPrices` on a fixed interval — exactly how production
// perps DEXs (GMX, Pyth keepers) feed their markets. Run it with the DEX admin key.
//
// Usage (from frontend/, where deps are installed):
//   VARA_SEED="//Alice"                      \   # MUST be the DEX admin (deployer)
//   PROGRAM_ID=0x…                           \   # the DEX program id
//   NODE_ADDRESS=wss://testnet.vara.network  \
//   node scripts/keeper.mjs
//
// Optional env:
//   INTERVAL_MS  push cadence in ms (default 15000)
//   IDL_PATH     path to an .idl that includes the Perps service
//                (default: ../../client/thebook_client.idl)

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { GearApi } from '@gear-js/api';
import { Keyring } from '@polkadot/api';
import { waitReady } from '@polkadot/wasm-crypto';
import { Sails } from 'sails-js';
import { SailsIdlParser } from 'sails-js-parser';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');

// Load both env files: .env.deploy carries the admin VARA_SEED, .env carries
// VITE_PROGRAM_ID. Already-set vars (e.g. a CLI override) take precedence, and
// the first file loaded wins for any key it shares with the second.
for (const f of [resolve(__dirname, '..', '.env.deploy'), resolve(__dirname, '..', '.env')]) {
  if (existsSync(f)) {
    try { process.loadEnvFile(f); } catch { /* ignore malformed file */ }
  }
}

const NODE_ADDRESS = process.env.NODE_ADDRESS ?? 'wss://testnet.vara.network';
const SEED = process.env.VARA_SEED;
const PROGRAM_ID = process.env.PROGRAM_ID ?? process.env.VITE_PROGRAM_ID;
// The root thebook.idl is stale (Orderbook + Amm only). The generated client IDL
// includes the Perps service that publishes mark prices, so default to it.
const IDL_PATH = process.env.IDL_PATH ?? resolve(repoRoot, 'client/thebook_client.idl');
// On-chain marks can only change once per block (~3s on Vara), so we push at block
// cadence. The UI ticker/chart keep updating in real-time from the off-chain feed.
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 2_500);

function fail(msg) { console.error(`\n  ✗ ${msg}\n`); process.exit(1); }

if (!SEED) fail('VARA_SEED is required (the DEX admin / deployer key).');
if (!PROGRAM_ID) fail('PROGRAM_ID (or VITE_PROGRAM_ID) is required.');
if (!existsSync(IDL_PATH)) fail(`IDL not found at ${IDL_PATH}.`);

/** Fetch a USD spot price, in cents (integer), or 0 if unavailable. */
async function priceCents(fetchers) {
  for (const f of fetchers) {
    try {
      const p = await f();
      if (p && isFinite(p) && p > 0) return Math.round(p * 100);
    } catch { /* try next source */ }
  }
  return 0;
}

const binance = (sym) => async () => {
  const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}`);
  const j = await r.json();
  return parseFloat(j.price);
};
const coingecko = (id) => async () => {
  const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
  const j = await r.json();
  return j[id]?.usd;
};

async function fetchMarks() {
  const [btc, eth, vara] = await Promise.all([
    priceCents([binance('BTCUSDT'), coingecko('bitcoin')]),
    priceCents([binance('ETHUSDT'), coingecko('ethereum')]),
    priceCents([coingecko('vara-network'), binance('VARAUSDT')]),
  ]);
  return { btc, eth, vara };
}

await waitReady();
const parser = await SailsIdlParser.new();
const sails = new Sails(parser);
sails.parseIdl(readFileSync(IDL_PATH, 'utf-8'));
const api = await GearApi.create({ providerAddress: NODE_ADDRESS });
sails.setApi(api);
sails.setProgramId(PROGRAM_ID);

const keyring = new Keyring({ type: 'sr25519' });
const account = keyring.addFromUri(SEED);

console.log(`\n  thebookdex price keeper`);
console.log(`  ───────────────────────`);
console.log(`  node:    ${NODE_ADDRESS}`);
console.log(`  program: ${PROGRAM_ID}`);
console.log(`  keeper:  ${account.address}`);
console.log(`  every:   ${INTERVAL_MS}ms\n`);

let running = true;
process.on('SIGINT', () => { running = false; });

async function pushOnce() {
  const { btc, eth, vara } = await fetchMarks();
  if (!btc && !eth && !vara) { console.warn('  · no prices fetched, skipping'); return; }
  const tx = sails.services.Perps.functions.SetMarkPrices(btc, eth, vara);
  tx.withAccount(account);
  await tx.calculateGas(true);
  const { response } = await tx.signAndSend();
  await response();
  const usd = (c) => c ? `$${(c / 100).toLocaleString()}` : '—';
  console.log(`  ✓ ${new Date().toISOString()}  BTC ${usd(btc)}  ETH ${usd(eth)}  VARA ${usd(vara)}`);
}

while (running) {
  try { await pushOnce(); }
  catch (e) { console.error(`  ✗ push failed: ${e?.message || e}`); }
  await new Promise((r) => setTimeout(r, INTERVAL_MS));
}

await api.disconnect();
process.exit(0);
