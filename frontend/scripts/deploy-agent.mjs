// Deploy a reference trading agent for thebookdex.
//
// Uploads the agent program and initializes it with New(thebook, name, strategy).
// On init the agent sends a Join to thebook, registering itself via Vara A2A. The
// deployer becomes the agent's owner (and initial keeper).
//
// Usage (from frontend/, where deps are installed):
//   VARA_SEED="//Alice"                        \  # becomes the agent owner
//   THEBOOK_ID=0x…                             \  # the DEX program id
//   AGENT_NAME="AlphaSeeker"                   \
//   AGENT_STRATEGY=ArbitrageHunter             \  # or MarketMaker | Momentum
//   NODE_ADDRESS=wss://testnet.vara.network    \
//   node scripts/deploy-agent.mjs
//
// Optional env:
//   WASM_PATH  path to the agent .opt.wasm (default: ../../target/wasm32-gear/release/thebook_agent.opt.wasm)
//   IDL_PATH   path to the agent .idl (default: ../../thebook_agent.idl)

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

for (const f of [resolve(__dirname, '..', '.env.deploy'), resolve(__dirname, '..', '.env')]) {
  if (existsSync(f)) { try { process.loadEnvFile(f); } catch { /* ignore */ } break; }
}

const NODE_ADDRESS = process.env.NODE_ADDRESS ?? 'wss://testnet.vara.network';
const SEED = process.env.VARA_SEED;
const THEBOOK_ID = process.env.THEBOOK_ID ?? process.env.PROGRAM_ID ?? process.env.VITE_PROGRAM_ID;
const NAME = process.env.AGENT_NAME ?? 'ReferenceAgent';
const STRATEGY = process.env.AGENT_STRATEGY ?? 'ArbitrageHunter';
const WASM_PATH = process.env.WASM_PATH ?? resolve(repoRoot, 'target/wasm32-gear/release/thebook_agent.opt.wasm');
const IDL_PATH = process.env.IDL_PATH ?? resolve(repoRoot, 'thebook_agent.idl');

function fail(msg) { console.error(`\n  ✗ ${msg}\n`); process.exit(1); }
if (!SEED) fail('VARA_SEED is required (becomes the agent owner).');
if (!THEBOOK_ID) fail('THEBOOK_ID (the DEX program id) is required.');
if (!['ArbitrageHunter', 'MarketMaker', 'Momentum'].includes(STRATEGY)) fail(`AGENT_STRATEGY must be ArbitrageHunter | MarketMaker | Momentum (got "${STRATEGY}").`);
if (!existsSync(WASM_PATH)) fail(`Agent WASM not found at ${WASM_PATH}. Build it: cargo build -p thebook-agent --release`);
if (!existsSync(IDL_PATH)) fail(`Agent IDL not found at ${IDL_PATH}.`);

await waitReady();
const parser = await SailsIdlParser.new();
const sails = new Sails(parser);
sails.parseIdl(readFileSync(IDL_PATH, 'utf-8'));
const api = await GearApi.create({ providerAddress: NODE_ADDRESS });
sails.setApi(api);

const keyring = new Keyring({ type: 'sr25519' });
const account = keyring.addFromUri(SEED);

console.log(`\n  deploy thebookdex agent`);
console.log(`  ───────────────────────`);
console.log(`  node:     ${NODE_ADDRESS}`);
console.log(`  owner:    ${account.address}`);
console.log(`  thebook:  ${THEBOOK_ID}`);
console.log(`  name:     ${NAME}`);
console.log(`  strategy: ${STRATEGY}\n`);

const code = readFileSync(WASM_PATH);
const tx = sails.ctors.New.fromCode(code, THEBOOK_ID, NAME, STRATEGY);
tx.withAccount(account);

console.log('  estimating gas…');
await tx.calculateGas(true);
const estimated = tx.gasInfo.min_limit.toBigInt();
const blockMax = api.blockGasLimit.toBigInt();
let gasLimit = estimated * 5n;
if (gasLimit > blockMax) gasLimit = blockMax;
tx.withGas(gasLimit);
console.log(`  gas: estimate ${estimated} → using ${gasLimit}`);

console.log('  uploading agent (sign & send)…');
const { msgId, blockHash, response } = await tx.signAndSend();
const programId = tx.programId;
await response();

console.log(`\n  ✓ agent deployed`);
console.log(`  agent id: ${programId}`);
console.log(`  init msg: ${msgId}`);
console.log(`  block:    ${blockHash}\n`);
console.log(`  Next: add it to the keeper —`);
console.log(`    AGENT_IDS=${programId} node scripts/agent-keeper.mjs\n`);

await api.disconnect();
process.exit(0);
