// One-shot deploy for thebookdex: deploy the CURRENT thebook program, register the
// admin, and print every env value.
//
// Virtual-balance model: joining grants starting balances, so no tokens are needed
// to trade. This deploy is lean by default (DEX only). Pass WITH_TOKENS=1 to also
// deploy + wire the four wrapped VFT tokens for the optional real-custody path
// (Deposit/Withdraw).
//
// Run this once with the admin account (it becomes the DEX admin). After it, set
// the printed VITE_* values in frontend/.env and redeploy the frontend. Then run
// scripts/keeper.mjs so futures have on-chain mark prices.
//
// Usage (from frontend/):
//   VARA_SEED="<funded admin seed>" node scripts/deploy-all.mjs
//   VARA_SEED="..." WITH_TOKENS=1 node scripts/deploy-all.mjs   # + custody tokens
//
// Env (auto-loaded from .env.deploy and .env):
//   VARA_SEED     the admin/deployer seed (required, must hold TVARA for gas)
//   NODE_ADDRESS  Vara RPC (default wss://testnet.vara.network)
// Optional:
//   WITH_TOKENS   "1" to also deploy the custody tokens (default: off)
//   DEX_WASM      default ../../target/wasm32-gear/release/thebook.opt.wasm
//   TOKEN_WASM    default ../../target/wasm32-gear/release/thebook_token.opt.wasm
//   IDL_PATH      default ../../client/thebook_client.idl (has New + all services)

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { GearApi } from '@gear-js/api';
import { Keyring } from '@polkadot/api';
import { u8aToHex, u8aConcat } from '@polkadot/util';
import { waitReady } from '@polkadot/wasm-crypto';
import { Sails } from 'sails-js';
import { SailsIdlParser } from 'sails-js-parser';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
for (const f of [resolve(__dirname, '..', '.env'), resolve(__dirname, '..', '.env.deploy')]) {
  if (existsSync(f)) { try { process.loadEnvFile(f); } catch { /* ignore */ } }
}

const NODE_ADDRESS = process.env.NODE_ADDRESS ?? 'wss://testnet.vara.network';
const SEED = process.env.VARA_SEED;
const DEX_WASM = process.env.DEX_WASM ?? resolve(repoRoot, 'target/wasm32-gear/release/thebook.opt.wasm');
const TOKEN_WASM = process.env.TOKEN_WASM ?? resolve(repoRoot, 'target/wasm32-gear/release/thebook_token.opt.wasm');
const IDL_PATH = process.env.IDL_PATH ?? resolve(repoRoot, 'client/thebook_client.idl');
const WITH_TOKENS = /^(1|true|yes)$/i.test(process.env.WITH_TOKENS ?? '');

function fail(m) { console.error(`\n  ✗ ${m}\n`); process.exit(1); }
if (!SEED) fail('VARA_SEED is required (a funded admin seed).');
if (!existsSync(DEX_WASM)) fail(`DEX WASM not found at ${DEX_WASM}. Build: cargo build --release`);
if (WITH_TOKENS && !existsSync(TOKEN_WASM)) fail(`Token WASM not found at ${TOKEN_WASM}. Build: cargo build -p thebook-token --release`);
if (!existsSync(IDL_PATH)) fail(`IDL not found at ${IDL_PATH}.`);

const TOKENS = [
  { kind: 'Usd',  name: 'thebook USD',     symbol: 'wUSDC', decimals: 6, faucet: 100_000n },
  { kind: 'Btc',  name: 'thebook Bitcoin', symbol: 'wBTC',  decimals: 6, faucet: 100_000n },
  { kind: 'Eth',  name: 'thebook Ether',   symbol: 'wETH',  decimals: 6, faucet: 1_000_000n },
  { kind: 'Vara', name: 'thebook Vara',    symbol: 'wVARA', decimals: 6, faucet: 1_000_000_000n },
];

await waitReady();
const api = await GearApi.create({ providerAddress: NODE_ADDRESS });
const keyring = new Keyring({ type: 'sr25519' });
const admin = keyring.addFromUri(SEED);
const sourceId = u8aToHex(admin.addressRaw);
const blockMax = api.blockGasLimit.toBigInt();

const parser = await SailsIdlParser.new();
const sails = new Sails(parser);
sails.parseIdl(readFileSync(IDL_PATH, 'utf-8'));
sails.setApi(api);

console.log(`\n  thebookdex full deploy`);
console.log(`  ──────────────────────`);
console.log(`  node:  ${NODE_ADDRESS}`);
console.log(`  admin: ${admin.address}\n`);

/** Upload a program (raw code + sails init payload) and return its program id. */
async function upload(code, payload, label) {
  const gas = await api.program.calculateGas.initUpload(sourceId, code, payload, 0, true);
  let limit = gas.min_limit.toBigInt() * 3n;
  if (limit > blockMax) limit = blockMax;
  const { programId, extrinsic } = api.program.upload({ code, gasLimit: limit, value: 0, initPayload: payload });
  await new Promise((res, rej) => {
    extrinsic.signAndSend(admin, ({ status, events, dispatchError }) => {
      if (dispatchError) return rej(new Error(dispatchError.toString()));
      if (status.isInBlock || status.isFinalized) {
        const failed = events.find(({ event }) => api.events.system.ExtrinsicFailed.is(event));
        failed ? rej(new Error(`${label}: upload failed on-chain`)) : res();
      }
    }).catch(rej);
  });
  return programId;
}

/** Send a sails call on the deployed DEX and await its reply. */
async function callDex(service, fn, ...args) {
  const tx = sails.services[service].functions[fn](...args);
  tx.withAccount(admin);
  await tx.calculateGas(true);
  const { response } = await tx.signAndSend();
  return response();
}

// ── 1 · deploy the current thebook DEX ──
process.stdout.write('  deploying thebook DEX … ');
const dexInit = u8aToHex(api.createType('String', 'New').toU8a());
const THEBOOK_ID = await upload(readFileSync(DEX_WASM), dexInit, 'thebook');
console.log(THEBOOK_ID);
sails.setProgramId(THEBOOK_ID);

// ── 2 · (optional) deploy + wire the four wrapped tokens for real custody ──
const env = { VITE_PROGRAM_ID: THEBOOK_ID };
if (WITH_TOKENS) {
  const tokenCode = readFileSync(TOKEN_WASM);
  for (const t of TOKENS) {
    const route = api.createType('String', 'New').toU8a();
    const targs = api.createType('(String, String, u8, U256)', [t.name, t.symbol, t.decimals, t.faucet]).toU8a();
    const payload = u8aToHex(u8aConcat(route, targs));
    process.stdout.write(`  deploying ${t.symbol} … `);
    const addr = await upload(tokenCode, payload, t.symbol);
    console.log(addr);
    process.stdout.write(`  wiring SetToken(${t.kind}) … `);
    await callDex('Orderbook', 'SetToken', t.kind, addr);
    console.log('ok');
    env[`VITE_TOKEN_${t.kind.toUpperCase()}`] = addr;
  }
} else {
  console.log('  tokens: skipped (virtual balances; pass WITH_TOKENS=1 to enable custody)');
}

// ── 3 · register the admin (Join = USDT only), then claim the one-time house
//        liquidity stockpile so the market maker has deep inventory to quote ──
try {
  process.stdout.write('  registering admin (Join) … ');
  await callDex('Orderbook', 'Join', 'House', 'MarketMaker');
  console.log('ok');
  process.stdout.write('  seeding house liquidity (SeedHouse) … ');
  await callDex('Orderbook', 'SeedHouse');
  console.log('ok');
} catch (e) {
  console.log(`skipped (${String(e?.message || e).slice(0, 60)})`);
}

console.log(`\n  ✓ deploy complete\n`);
console.log(`  Next: run the keeper AND the market maker against the new program:`);
console.log(`    node scripts/keeper.mjs`);
console.log(`    node scripts/market-maker.mjs\n`);
console.log(`  Put these in frontend/.env, then redeploy the frontend:\n`);
for (const [k, v] of Object.entries(env)) console.log(`    ${k}=${v}`);
console.log(`\n  Then start the mark-price keeper so futures work:`);
console.log(`    node scripts/keeper.mjs`);
console.log(`\n  (Optional) fund the perps reserve later:`);
console.log(`    node scripts/fund-reserve.mjs\n`);

await api.disconnect();
process.exit(0);
