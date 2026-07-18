// Agent keeper for thebookdex.
//
// Deployed trading agents are on-chain programs with an `Act()` entrypoint. This
// keeper pokes each configured agent's Act() on a cadence — that's the autonomy
// model: the agent stays a thin on-chain executor, the keeper provides the clock.
// Run it with an account that each agent has authorized (its owner, or a keeper
// address set via SetKeeper).
//
// Usage (from frontend/, where deps are installed):
//   VARA_SEED="//Alice"                        \  # owner/keeper of the agents
//   AGENT_IDS=0xabc..,0xdef..                  \  # comma-separated agent program ids
//   NODE_ADDRESS=wss://testnet.vara.network    \
//   node scripts/agent-keeper.mjs
//
// Optional env:
//   INTERVAL_MS  poke cadence in ms (default 30000)
//   IDL_PATH     path to the agent .idl (default: ../../thebook_agent.idl)

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
const SEED = process.env.VARA_SEED ?? process.env.KEEPER_SEED;
const AGENT_IDS = (process.env.AGENT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const IDL_PATH = process.env.IDL_PATH ?? resolve(repoRoot, 'thebook_agent.idl');
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 30_000);

function fail(msg) { console.error(`\n  ✗ ${msg}\n`); process.exit(1); }
if (!SEED) fail('VARA_SEED (or KEEPER_SEED) is required — an owner/keeper of the agents.');
if (AGENT_IDS.length === 0) fail('AGENT_IDS is required (comma-separated agent program ids).');
if (!existsSync(IDL_PATH)) fail(`Agent IDL not found at ${IDL_PATH}.`);

await waitReady();
const parser = await SailsIdlParser.new();
const sails = new Sails(parser);
sails.parseIdl(readFileSync(IDL_PATH, 'utf-8'));
const api = await GearApi.create({ providerAddress: NODE_ADDRESS });
sails.setApi(api);

const keyring = new Keyring({ type: 'sr25519' });
const account = keyring.addFromUri(SEED);

console.log(`\n  thebookdex agent keeper`);
console.log(`  ───────────────────────`);
console.log(`  node:    ${NODE_ADDRESS}`);
console.log(`  keeper:  ${account.address}`);
console.log(`  agents:  ${AGENT_IDS.length}`);
console.log(`  every:   ${INTERVAL_MS}ms\n`);

let running = true;
process.on('SIGINT', () => { running = false; });

async function pokeOne(agentId) {
  sails.setProgramId(agentId);
  const tx = sails.services.Agent.functions.Act();
  tx.withAccount(account);
  await tx.calculateGas(true);
  const { response } = await tx.signAndSend();
  const note = await response();
  console.log(`  ✓ ${new Date().toISOString()}  ${agentId.slice(0, 10)}…  ${note}`);
}

async function pokeAll() {
  for (const id of AGENT_IDS) {
    try { await pokeOne(id); }
    catch (e) { console.error(`  ✗ ${id.slice(0, 10)}… ${e?.message || e}`); }
  }
}

while (running) {
  await pokeAll();
  await new Promise((r) => setTimeout(r, INTERVAL_MS));
}

await api.disconnect();
process.exit(0);
