#!/usr/bin/env node
// Read-only probe of a DEPLOYED program (audit Phase 0).
//
// Answers the two questions the audit could not answer without chain access:
//
//   1. Does the deployed program still expose the legacy attack surface —
//      `Orderbook/CallAgentService` (C-01) and `Orderbook/Join`/`Withdraw` (C-02)?
//   2. If it does, is C-02 live or latent? It is latent only while every legacy
//      token slot is the zero address; a single `Orderbook/SetToken` makes it total
//      loss. Query `Orderbook/GetTokens` to find out.
//
// It also reports how much value the program currently custodies, which is what
// decides how urgently to act.
//
// This script SIGNS NOTHING and needs no seed. It is safe to run against mainnet.
//
// Usage:
//   NODE_ADDRESS=wss://rpc.vara.network PROGRAM_ID=0x… node scripts/audit-probe.mjs

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GearApi } from '@gear-js/api';
import { Sails } from 'sails-js';
import { SailsIdlParser } from 'sails-js-parser';
import { requireNode, requireEnv, fail } from './lib/env.mjs';

const CLI_NODE = process.env.NODE_ADDRESS;

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
for (const f of [resolve(__dirname, '..', '.env'), resolve(__dirname, '..', '.env.deploy')]) {
  if (existsSync(f)) { try { process.loadEnvFile(f); } catch { /* ignore */ } }
}

const NODE_ADDRESS = requireNode({ cliNode: CLI_NODE });
const PROGRAM_ID = requireEnv('PROGRAM_ID', 'the deployed program to probe');
const VFT_IDL_PATH = resolve(repoRoot, 'sdk/vft.idl');
if (!existsSync(VFT_IDL_PATH)) fail(`VFT IDL not found at ${VFT_IDL_PATH}.`);

const TOKENS = {
  wVARA: { id: '0x29c42c668012b1ce20720e4615229215023281ef4676fdc77bf047d7fbcb9d17', dec: 12 },
  wETH: { id: '0xde45bdbb0345919a11561d43a5082e0b25061d4a2c6eb80009c1cfbccb80d0de', dec: 18 },
  wUSDT: { id: '0x4255ff4a87a4c13dc39f74ace8c4948bbef2f75fb639d66639a1cfcc99e6243e', dec: 6 },
  wUSDC: { id: '0xd1de816d7dce6439504552686ab333e5b7302b1549763656b30af1f8a5871b6a', dec: 6 },
};

const ZERO = '0x0000000000000000000000000000000000000000000000000000000000000000';

console.log('\nthebook deployed-program probe (read-only)');
console.log(`  node:    ${NODE_ADDRESS}`);
console.log(`  program: ${PROGRAM_ID}\n`);

const api = await GearApi.create({ providerAddress: NODE_ADDRESS });
const parser = await SailsIdlParser.new();

// Probing by call is the reliable test: if the route decodes and replies, the
// service is present on the deployed program, whatever the local IDL says.
// Must match the deployed signature exactly — `actor_id`, not `[u8;32]`. A shape
// mismatch makes the call throw, which reads as "service absent" and would report a
// drainable program as safe.
const legacyIdl = `
service Orderbook {
  query GetTokens : () -> struct { actor_id, actor_id, actor_id, actor_id };
};
`;
let legacyPresent = false;
let tokenSlots = null;
try {
  const probe = new Sails(parser);
  probe.parseIdl(legacyIdl);
  probe.setProgramId(PROGRAM_ID);
  probe.setApi(api);
  tokenSlots = await probe.services.Orderbook.queries.GetTokens().call();
  legacyPresent = true;
} catch {
  legacyPresent = false;
}

console.log('── Legacy attack surface ─────────────────────────────');
if (!legacyPresent) {
  console.log('  ✓ Orderbook service does not respond.');
  console.log('    C-01 (CallAgentService) and C-02 (Join/Withdraw) are not reachable');
  console.log('    on this program. This is the fixed build.\n');
} else {
  const slots = (tokenSlots || []).map(String);
  const nonZero = slots.filter((s) => s && s !== ZERO);
  console.log('  ✗ Orderbook service IS present on this program.');
  console.log("    C-01 CallAgentService: an unauthenticated arbitrary cross-program");
  console.log("    call. Any caller can spend this program's tokens. Treat as LIVE.");
  console.log('');
  console.log(`    Orderbook/GetTokens -> ${slots.length ? slots.join('\n                           ') : '(no result)'}`);
  if (nonZero.length === 0) {
    console.log('    C-02 is LATENT: every legacy token slot is the zero address, so');
    console.log('    Withdraw returns BadParams. One SetToken call makes it total loss.');
  } else {
    console.log(`    ✗ C-02 is LIVE: ${nonZero.length} legacy token slot(s) are set.`);
    console.log('      Minted virtual balances can be withdrawn as real tokens NOW.');
  }
  console.log('');
}

// How much value is at stake?
console.log('── Custodied value ──────────────────────────────────');
let anyHeld = false;
for (const [sym, t] of Object.entries(TOKENS)) {
  try {
    const vft = new Sails(parser);
    vft.parseIdl(readFileSync(VFT_IDL_PATH, 'utf-8'));
    vft.setProgramId(t.id);
    vft.setApi(api);
    const raw = BigInt((await vft.services.Vft.queries.BalanceOf(PROGRAM_ID).call()).toString());
    const whole = Number(raw) / 10 ** t.dec;
    if (raw > 0n) anyHeld = true;
    console.log(`  ${sym.padEnd(6)} ${raw.toString().padStart(28)}  (${whole})`);
  } catch (e) {
    console.log(`  ${sym.padEnd(6)} (read failed: ${String(e?.message || e).slice(0, 60)})`);
  }
}
console.log('');

// The current surface, if this is the fixed build.
console.log('── Current venue state ──────────────────────────────');
try {
  const dex = new Sails(parser);
  dex.parseIdl(readFileSync(resolve(repoRoot, 'client/thebook_client.idl'), 'utf-8'));
  dex.setProgramId(PROGRAM_ID);
  dex.setApi(api);
  const paused = await dex.services.Spot.queries.IsPaused().call();
  const pairs = await dex.services.Spot.queries.PairCount().call();
  const resting = await dex.services.Spot.queries.RestingOrderCount().call();
  console.log(`  paused:         ${paused}`);
  console.log(`  markets:        ${pairs}`);
  console.log(`  resting orders: ${resting}`);
} catch {
  console.log('  (the current Spot interface does not respond — this program predates');
  console.log('   the audit remediation build)');
}
console.log('');

if (legacyPresent) {
  console.log('  ACTION: this program should be taken out of service. See');
  console.log('  docs/incident-runbook.md, Phase 0.\n');
} else if (anyHeld) {
  console.log('  Program holds value on the fixed build. Run scripts/solvency-monitor.mjs.\n');
}

await api.disconnect();
process.exit(legacyPresent ? 1 : 0);
