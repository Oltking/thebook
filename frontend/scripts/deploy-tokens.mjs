// Deploy thebookdex's wrapped test tokens (wUSDC / wBTC / wETH / wVARA) and wire
// them into the DEX. Run this ONCE with the DEX admin account (the deployer of
// thebook), then set the printed VITE_TOKEN_* env vars and redeploy the frontend.
// After this, deposit / withdraw and real-asset custody are live.
//
// Usage (from frontend/, where deps are installed):
//   VARA_SEED="//Alice"                        \  # MUST be the DEX admin (deployer)
//   THEBOOK_ID=0x…                             \  # the DEX program id
//   NODE_ADDRESS=wss://testnet.vara.network    \
//   node scripts/deploy-tokens.mjs
//
// Optional env:
//   WASM_PATH  path to thebook_token.opt.wasm (default: ../../target/wasm32-gear/release/thebook_token.opt.wasm)
//   IDL_PATH   thebook IDL with SetToken (default: ../../client/thebook_client.idl)
//
// The token program must be built first:
//   cargo build -p thebook-token --release

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { GearApi } from '@gear-js/api';
import { Keyring } from '@polkadot/api';
import { u8aToHex, u8aConcat } from '@polkadot/util';
import { waitReady } from '@polkadot/wasm-crypto';
import { Sails } from 'sails-js';
import { SailsIdlParser } from 'sails-js-parser';
import { requireNode } from './lib/env.mjs';

// Captured before any dotfile is loaded: an explicitly-passed NODE_ADDRESS must
// win, so a stale value in frontend/.env cannot redirect a signed action to the
// wrong chain (audit H-09).
const CLI_NODE = process.env.NODE_ADDRESS;

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
// Load BOTH env files: .env.deploy has the admin seed, .env has VITE_PROGRAM_ID.
for (const f of [resolve(__dirname, '..', '.env'), resolve(__dirname, '..', '.env.deploy')]) {
  if (existsSync(f)) { try { process.loadEnvFile(f); } catch { /* ignore */ } }
}

// Required, no default: this script signs (audit H-09).
const NODE_ADDRESS = requireNode({ cliNode: CLI_NODE });
const SEED = process.env.VARA_SEED;
const THEBOOK_ID = process.env.THEBOOK_ID ?? process.env.PROGRAM_ID ?? process.env.VITE_PROGRAM_ID;
const WASM_PATH = process.env.WASM_PATH ?? resolve(repoRoot, 'target/wasm32-gear/release/thebook_token.opt.wasm');
const IDL_PATH = process.env.IDL_PATH ?? resolve(repoRoot, 'client/thebook_client.idl');

function fail(m) { console.error(`\n  ✗ ${m}\n`); process.exit(1); }
if (!SEED) fail('VARA_SEED is required (the DEX admin / deployer key).');
if (!THEBOOK_ID) fail('THEBOOK_ID (the DEX program id) is required.');
if (!existsSync(WASM_PATH)) fail(`Token WASM not found at ${WASM_PATH}. Build it: cargo build -p thebook-token --release`);
if (!existsSync(IDL_PATH)) fail(`thebook IDL not found at ${IDL_PATH}.`);

// name, symbol, decimals, and the per-account faucet amount (base units). These
// faucet amounts match the app's onboarding claim, so keep them in sync.
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

console.log(`\n  deploy thebookdex tokens`);
console.log(`  ────────────────────────`);
console.log(`  node:    ${NODE_ADDRESS}`);
console.log(`  admin:   ${admin.address}`);
console.log(`  thebook: ${THEBOOK_ID}\n`);

const code = readFileSync(WASM_PATH);

/** SCALE-encode the sails constructor call: String("New") + (name, symbol, u8, u256). */
function initPayload(t) {
  const route = api.createType('String', 'New').toU8a();
  const args = api.createType('(String, String, u8, U256)', [t.name, t.symbol, t.decimals, t.faucet]).toU8a();
  return u8aToHex(u8aConcat(route, args));
}

async function deployToken(t) {
  const payload = initPayload(t);
  // Gas estimation wants the 32-byte account id in hex, NOT the SS58 string.
  const sourceId = u8aToHex(admin.addressRaw);
  const gas = await api.program.calculateGas.initUpload(sourceId, code, payload, 0, true);
  // Buffer the estimate, but never exceed the block gas limit.
  const blockMax = api.blockGasLimit.toBigInt();
  let limit = gas.min_limit.toBigInt() * 3n;
  if (limit > blockMax) limit = blockMax;
  const { programId, extrinsic } = api.program.upload({ code, gasLimit: limit, value: 0, initPayload: payload });
  await new Promise((res, rej) => {
    extrinsic.signAndSend(admin, ({ status, events, dispatchError }) => {
      if (dispatchError) return rej(new Error(dispatchError.toString()));
      if (status.isInBlock || status.isFinalized) {
        const failed = events.find(({ event }) => api.events.system.ExtrinsicFailed.is(event));
        failed ? rej(new Error('upload failed on-chain')) : res();
      }
    }).catch(rej);
  });
  return programId;
}

// thebook client for the admin-only SetToken calls.
const parser = await SailsIdlParser.new();
const sails = new Sails(parser);
sails.parseIdl(readFileSync(IDL_PATH, 'utf-8'));
sails.setApi(api);
sails.setProgramId(THEBOOK_ID);

async function setToken(kind, address) {
  const tx = sails.services.Orderbook.functions.SetToken(kind, address);
  tx.withAccount(admin);
  await tx.calculateGas(true);
  const { response } = await tx.signAndSend();
  await response();
}

const env = {};
for (const t of TOKENS) {
  process.stdout.write(`  deploying ${t.symbol} … `);
  const addr = await deployToken(t);
  console.log(addr);
  process.stdout.write(`  wiring SetToken(${t.kind}) … `);
  await setToken(t.kind, addr);
  console.log('ok');
  env[`VITE_TOKEN_${t.kind.toUpperCase()}`] = addr;
}

console.log(`\n  ✓ all tokens deployed and wired\n`);
console.log(`  Add these to frontend/.env, then redeploy the frontend:\n`);
for (const [k, v] of Object.entries(env)) console.log(`    ${k}=${v}`);
console.log('');

await api.disconnect();
process.exit(0);
