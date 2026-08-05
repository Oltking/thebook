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
// ASSETS default "BTC" (book tick = $1000/unit is too coarse for ETH/VARA).

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
const ASSETS = (process.env.ASSETS ?? 'BTC').split(',').map((s) => s.trim().toUpperCase());
const fail = (m) => { console.error(`\n  ✗ ${m}\n`); process.exit(1); };
if (!SEED) fail('VARA_SEED is required (the DEX admin seed).');
if (!PROGRAM_ID) fail('PROGRAM_ID is required.');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LADDER = [{ off: 0, size: 2 }, { off: 1, size: 4 }, { off: 2, size: 8 }];

// ── price sources (keyless, CORS-free in Node) ──
async function usdPrices() {
  const out = { btc: 0, eth: 0, vara: 0 };
  try {
    const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbols=%5B%22BTCUSDT%22,%22ETHUSDT%22%5D');
    for (const row of await r.json()) {
      if (row.symbol === 'BTCUSDT') out.btc = parseFloat(row.price);
      if (row.symbol === 'ETHUSDT') out.eth = parseFloat(row.price);
    }
  } catch { /* leave 0 */ }
  try {
    const r = await fetch('https://api.coinpaprika.com/v1/tickers/vara-vara-network');
    const p = (await r.json())?.quotes?.USD?.price;
    if (p) out.vara = p;
  } catch { /* leave 0 */ }
  return out;
}
const cents = (usd) => Math.round(usd * 100);

const book = await connectTheBook({ seed: SEED, programId: PROGRAM_ID, node: NODE_ADDRESS });
console.log(`\n  thebookdex market runner (marks + house quotes)`);
console.log(`  node:   ${NODE_ADDRESS}`);
console.log(`  house:  ${book.address}`);
console.log(`  assets: ${ASSETS.join(', ')}  ·  loop ${INTERVAL_MS}ms\n`);

await book.join('House', Strategy.MarketMaker);
try { console.log('  house stockpile:', await book.seedHouse()); }
catch (e) { console.warn('  seed_house skipped:', e?.message || e); }

async function tick() {
  const p = await usdPrices();
  // 1) push marks (cents). VARA rounds to 0 cents at its price — expected.
  await book.setMarks(cents(p.btc), cents(p.eth), cents(p.vara));
  // 2) requote: clear our resting orders, then re-ladder both sides.
  const mine = await book.myOrders().catch(() => []);
  for (const o of Array.isArray(mine) ? mine : []) { try { await book.cancelOrder(o[0]); } catch { /* gone */ } }
  for (const a of ASSETS) {
    const usd = p[a.toLowerCase()];
    if (!usd || usd <= 0) continue;
    const t = Math.max(1, Math.round(usd / 1000));
    for (const { off, size } of LADDER) {
      try { await book.placeLimit(Side.Sell, Asset[a], t + off, book.qty(size)); } catch { /* skip */ }
      const bid = t - 1 - off;
      if (bid >= 1) { try { await book.placeLimit(Side.Buy, Asset[a], bid, book.qty(size)); } catch { /* skip */ } }
    }
  }
  console.log(`  ✓ ${new Date().toISOString()}  marks BTC $${p.btc} ETH $${p.eth} VARA $${p.vara}  ·  quoted ${ASSETS.join(',')}`);
}

let running = true;
process.on('SIGINT', () => { running = false; });
while (running) {
  try { await tick(); } catch (e) { console.error(`  ✗ ${e?.message || e}`); }
  await sleep(INTERVAL_MS);
}
await book.disconnect();
process.exit(0);
