// Deploy the thebook DEX program to a Vara network (testnet by default).
//
// Usage (from the frontend/ directory, where deps are installed):
//   VARA_SEED="//Alice"                 \   # account mnemonic or dev seed, MUST be funded
//   NODE_ADDRESS=wss://testnet.vara.network \
//   node scripts/deploy.mjs
//
// Optional env:
//   WASM_PATH  path to the compiled .opt.wasm (default: ../target/wasm32-gear/release/thebook.opt.wasm)
//   IDL_PATH   path to the generated .idl     (default: ../thebook.idl)
//
// On success it prints the new program ID — put it in frontend/.env as VITE_PROGRAM_ID.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { GearApi } from '@gear-js/api';
import { Keyring } from '@polkadot/api';
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

// Load secrets from a local, gitignored env file if present so you don't have to
// pass VARA_SEED on the command line. `.env.deploy` is preferred (keeps the seed
// out of the frontend's `.env`); falls back to `.env`. Real environment variables
// still take precedence over file values.
for (const f of [resolve(__dirname, '..', '.env.deploy'), resolve(__dirname, '..', '.env')]) {
  if (existsSync(f)) {
    try { process.loadEnvFile(f); } catch { /* ignore malformed file */ }
    break;
  }
}

// Required, no default: this script signs (audit H-09).
const NODE_ADDRESS = requireNode({ cliNode: CLI_NODE });
const SEED = process.env.VARA_SEED;
const WASM_PATH =
  process.env.WASM_PATH ?? resolve(repoRoot, 'target/wasm32-gear/release/thebook.opt.wasm');
const IDL_PATH = process.env.IDL_PATH ?? resolve(repoRoot, 'thebook.idl');

function fail(msg) {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}

if (!SEED) fail('VARA_SEED is required (a funded account mnemonic or dev seed like "//Alice").');
if (!existsSync(WASM_PATH)) fail(`WASM not found at ${WASM_PATH}. Build it first: cargo build --release`);
if (!existsSync(IDL_PATH)) fail(`IDL not found at ${IDL_PATH}.`);

console.log(`\n  thebookdex deploy`);
console.log(`  ─────────────────`);
console.log(`  node:  ${NODE_ADDRESS}`);
console.log(`  wasm:  ${WASM_PATH}`);
console.log(`  idl:   ${IDL_PATH}\n`);

await waitReady();

const parser = await SailsIdlParser.new();
const sails = new Sails(parser);
sails.parseIdl(readFileSync(IDL_PATH, 'utf-8'));

const api = await GearApi.create({ providerAddress: NODE_ADDRESS });
sails.setApi(api);

const keyring = new Keyring({ type: 'sr25519' });
const account = keyring.addFromUri(SEED);
console.log(`  deployer: ${account.address}`);

const code = readFileSync(WASM_PATH);
const tx = sails.ctors.New.fromCode(code);
tx.withAccount(account);

console.log('  estimating gas…');
// The RPC returns the *minimum* limit, which can undershoot the real init cost for
// a non-wasm-opt'd binary. Apply a generous multiple (unused gas is refunded on
// Vara), capped at the block gas limit.
await tx.calculateGas(true);
const estimated = tx.gasInfo.min_limit.toBigInt();
const blockMax = api.blockGasLimit.toBigInt();
let gasLimit = estimated * 5n;
if (gasLimit > blockMax) gasLimit = blockMax;
tx.withGas(gasLimit);
console.log(`  gas: estimate ${estimated} → using ${gasLimit} (block max ${blockMax})`);

console.log('  uploading program (sign & send)…');
const { msgId, blockHash, response } = await tx.signAndSend();
const programId = tx.programId;

// Wait for the init reply so we surface init failures instead of a dangling program.
await response();

console.log(`\n  ✓ deployed`);
console.log(`  program id: ${programId}`);
console.log(`  init msg:   ${msgId}`);
console.log(`  block:      ${blockHash}\n`);
console.log(`  Next: set VITE_PROGRAM_ID=${programId} in frontend/.env\n`);

await api.disconnect();
process.exit(0);
