// Mainnet deploy + init for thebook v1 (spot + perps).
//
// Deploys the new spot/perps program, then curates the markets and wires perps. The
// quote/base tokens are EXISTING bridged VFTs on Vara mainnet (RivrDEX's wUSDT/wUSDC/
// wVARA/wETH) — we only reference their addresses, we do NOT deploy them.
//
// Run ONCE with the admin seed (it becomes the DEX admin; transfer to the multisig
// afterwards with Spot/ProposeAdmin + AcceptAdmin, and PerpsV1/SetKeeper).
//
// Usage (from frontend/):
//   VARA_SEED="<funded mainnet admin seed>" node scripts/deploy-mainnet.mjs
//
// Env (auto-loaded from .env / .env.deploy):
//   VARA_SEED     admin/deployer seed (required; must hold mainnet VARA for gas)
//   NODE_ADDRESS  Vara RPC (REQUIRED — no default; this script signs)
//   KEEPER        REQUIRED ss58/hex account allowed to push perp marks. Must be a
//                 dedicated key, NOT the admin seed (audit H-04, H-09).
//   DEX_WASM      default ../../target/wasm32-gear/release/thebook.opt.wasm
//   IDL_PATH      default ../../client/thebook_client.idl (has New + all services)
//
// After it prints VITE_PROGRAM_ID, put that in frontend/.env and redeploy the frontend,
// then fund the perps reserve (approve wUSDT to the DEX, then PerpsV1/FundReserve).

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { GearApi } from '@gear-js/api';
import { Keyring } from '@polkadot/api';
import { u8aToHex } from '@polkadot/util';
import { decodeAddress } from '@polkadot/util-crypto';
import { waitReady } from '@polkadot/wasm-crypto';
import { Sails } from 'sails-js';
import { SailsIdlParser } from 'sails-js-parser';
import { requireNode, fail } from './lib/env.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
// An explicitly-passed NODE_ADDRESS (CLI env) must win over the .env files, so a
// testnet value in frontend/.env can't silently redirect a mainnet deploy.
const CLI_NODE = process.env.NODE_ADDRESS;
for (const f of [resolve(__dirname, '..', '.env'), resolve(__dirname, '..', '.env.deploy')]) {
  if (existsSync(f)) { try { process.loadEnvFile(f); } catch { /* ignore */ } }
}

// Required, no default: this script signs (audit H-09).
const NODE_ADDRESS = requireNode({ cliNode: CLI_NODE });
const SEED = process.env.VARA_SEED;
const KEEPER = process.env.KEEPER;
// Deploy paused unless explicitly told otherwise — see the note at the pause call.
const LAND_PAUSED = process.env.DEPLOY_UNPAUSED !== '1';
const DEX_WASM = process.env.DEX_WASM ?? resolve(repoRoot, 'target/wasm32-gear/release/thebook.opt.wasm');
const IDL_PATH = process.env.IDL_PATH ?? resolve(repoRoot, 'client/thebook_client.idl');

// Preflight. Everything that can be checked BEFORE the first signed transaction is
// checked here — a deploy that fails half-way leaves a live program with markets
// listed and no keeper, which is worse than not deploying at all.
if (!SEED) fail('VARA_SEED is required (a funded mainnet admin seed).');
if (!KEEPER) {
  fail(
    'KEEPER is required — a dedicated account allowed to publish mark prices.\n' +
    '    It must NOT be the admin seed: the contract no longer accepts admin as an\n' +
    '    implicit keeper, and an always-on worker should not hold listing, pause and\n' +
    '    reserve authority (audit H-04, H-09).',
  );
}
if (!existsSync(DEX_WASM)) fail(`DEX WASM not found at ${DEX_WASM}. Build: cargo build --release`);
if (!existsSync(IDL_PATH)) fail(`IDL not found at ${IDL_PATH}.`);

// Confirmed Vara-side token program ids + decimals (see docs/mainnet-addresses.md).
const T = {
  wVARA: { addr: '0x29c42c668012b1ce20720e4615229215023281ef4676fdc77bf047d7fbcb9d17', dec: 12 },
  wETH:  { addr: '0xde45bdbb0345919a11561d43a5082e0b25061d4a2c6eb80009c1cfbccb80d0de', dec: 18 },
  wUSDT: { addr: '0x4255ff4a87a4c13dc39f74ace8c4948bbef2f75fb639d66639a1cfcc99e6243e', dec: 6 },
  wUSDC: { addr: '0xd1de816d7dce6439504552686ab333e5b7302b1549763656b30af1f8a5871b6a', dec: 6 },
};

// Spot markets to list: base ETH and VARA, each vs USDT and USDC.
const MARKETS = [
  { name: 'ETH/USDT',  base: T.wETH,  quote: T.wUSDT },
  { name: 'ETH/USDC',  base: T.wETH,  quote: T.wUSDC },
  { name: 'VARA/USDT', base: T.wVARA, quote: T.wUSDT },
  { name: 'VARA/USDC', base: T.wVARA, quote: T.wUSDC },
];
// Perp markets (mark feed by symbol). Collateral = wUSDT.
//
// `maxOi` is REQUIRED at creation and has no unlimited default: the reserve's
// directional exposure must be bounded from the first block, not by an operator
// remembering a separate `SetMarketCap` call (audit M-03). These are conservative
// opening caps in wUSDT smallest-units (6 decimals) — raise them deliberately once
// the reserve is funded and the market has traded.
const PERP_MARKETS = [
  { symbol: 'ETH', maxOi: 25_000_000_000n },   // 25,000 wUSDT per side
  { symbol: 'VARA', maxOi: 10_000_000_000n },  // 10,000 wUSDT per side
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

console.log(`\n  thebook v1 mainnet deploy`);
console.log(`  ─────────────────────────`);
console.log(`  node:  ${NODE_ADDRESS}`);
console.log(`  admin: ${admin.address}\n`);

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

/**
 * Gear's gas-estimation RPC cannot simulate a program that awaits a cross-program
 * reply — it aborts with "Unable to call a forbidden function". `ListPair` reads each
 * token's decimals, and every escrowing method awaits a transfer, so estimation is
 * allowed to fail and we fall back to an explicit limit. Unused gas is refunded.
 */
async function prepareGas(tx) {
  try {
    // The node returns the MINIMUM viable limit. Any variance between
    // estimating and executing busts it, so pad by 100%. Unused gas
    // is refunded, so the padding costs nothing.
    await tx.calculateGas(true, 100);
  } catch (e) {
    if (!/forbidden function/i.test(String(e?.message ?? e))) throw e;
    tx.withGas('max');
  }
}

async function call(service, fn, ...args) {
  const tx = sails.services[service].functions[fn](...args);
  tx.withAccount(admin);
  await prepareGas(tx);
  const { response } = await tx.signAndSend();
  const value = await response();
  if (value && typeof value === 'object' && 'err' in value) {
    throw new Error(`${service}.${fn} rejected: ${JSON.stringify(value.err)}`);
  }
  return value && typeof value === 'object' && 'ok' in value ? value.ok : value;
}

// 1 · deploy the program
// Resumable: if EXISTING_PROGRAM is set, initialise that program instead of
// uploading a second one. Deploy is the expensive, irreversible step; the wiring
// after it can fail on a transient RPC error and should be retryable without
// stranding a half-initialised program on chain.
let PROGRAM_ID;
if (process.env.EXISTING_PROGRAM) {
  PROGRAM_ID = process.env.EXISTING_PROGRAM;
  console.log(`  using existing program … ${PROGRAM_ID}`);
} else {
  process.stdout.write('  deploying thebook v1 … ');
  const dexInit = u8aToHex(api.createType('String', 'New').toU8a());
  PROGRAM_ID = await upload(readFileSync(DEX_WASM), dexInit, 'thebook');
  console.log(PROGRAM_ID);
}
sails.setProgramId(PROGRAM_ID);

// 2 · list spot markets
console.log('\n  listing spot markets:');
for (const m of MARKETS) {
  try {
    const id = await call('Spot', 'ListPair', m.base.addr, m.quote.addr, m.base.dec, m.quote.dec);
    console.log(`    ${m.name.padEnd(10)} pair_id=${id}`);
  } catch (e) {
    // Already listed by an earlier run — not an error when resuming.
    if (/PairExists/.test(String(e?.message ?? e))) {
      console.log(`    ${m.name.padEnd(10)} already listed, skipping`);
    } else {
      throw e;
    }
  }
}

// 3 · wire perps: collateral, markets, keeper
console.log('\n  wiring perps:');
await call('PerpsV1', 'SetCollateral', T.wUSDT.addr);
console.log(`    collateral = wUSDT`);
for (const m of PERP_MARKETS) {
  const id = await call('PerpsV1', 'AddMarket', m.symbol, m.maxOi.toString());
  console.log(`    market ${m.symbol.padEnd(5)} id=${id}  max_oi=${m.maxOi} (per side)`);
}
// actor_id args must be 32-byte hex, not an SS58 string.
//
// The keeper must be its OWN key, not the admin: the contract no longer accepts
// admin as an implicit keeper, and an always-on worker should not hold listing,
// pause and reserve authority (audit H-04, H-09).
const keeperHex = u8aToHex(decodeAddress(KEEPER));
if (keeperHex === sourceId) {
  fail('KEEPER must not be the admin account. Generate a separate keeper key.');
}
await call('PerpsV1', 'SetKeeper', keeperHex);
console.log(`    keeper = ${keeperHex}`);

// 4 · Land PAUSED by default.
//
// A fresh program has empty books, no funded reserve, no running keeper and no
// multisig — none of the launch gate is satisfied at the moment it goes live. Leaving
// it open invites the first deposit into exactly that state. Pausing blocks new
// orders and positions while leaving cancel and withdraw open, so nothing can be
// trapped; open it with Spot/SetPaused(false) when the gate is actually met.
if (LAND_PAUSED) {
  await call('Spot', 'SetPaused', true);
  console.log(`\n  venue is PAUSED (set DEPLOY_UNPAUSED=1 to skip this)`);
}

console.log(`\n  ✓ deploy complete\n`);
console.log(`  Put this in frontend/.env, then redeploy the frontend:`);
console.log(`    VITE_PROGRAM_ID=${PROGRAM_ID}\n`);
console.log(`  Next — none of this is optional before real funds:`);
if (LAND_PAUSED) {
  console.log(`    • the venue is PAUSED. Open it last, with Spot/SetPaused(false)`);
}
console.log(`    • fund the perps reserve: approve wUSDT to the DEX, then PerpsV1/FundReserve`);
console.log(`    • start the mark keeper on its own key (scripts/perps-keeper.mjs)`);
console.log(`    • start the solvency monitor (scripts/solvency-monitor.mjs)`);
console.log(`    • hand admin to the multisig: Spot/ProposeAdmin, then AcceptAdmin`);
console.log(`      from the multisig itself — the handover is two-step by design\n`);

await api.disconnect();
process.exit(0);
