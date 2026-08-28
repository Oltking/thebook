#!/usr/bin/env node
// Return native VARA from the rehearsal's derived accounts to the admin.
//
// The harness derives its trader and keeper from the admin seed (`//rehearsal-trader`,
// `//rehearsal-keeper`) so no extra key has to be created or stored. Their balances
// are therefore never lost, but they do accumulate: gas is topped up per run and only
// partly spent. This sweeps the excess back so the admin can afford the next deploy.
//
// Leaves a floor in each account so they stay usable and above the existential
// deposit.
//
// Usage (from frontend/):
//   NODE_ADDRESS=wss://rpc.vara.network node scripts/sweep-derived.mjs

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GearApi } from '@gear-js/api';
import { Keyring } from '@polkadot/api';
import { waitReady } from '@polkadot/wasm-crypto';
import { requireNode, requireEnv } from './lib/env.mjs';

const CLI_NODE = process.env.NODE_ADDRESS;
const __dirname = dirname(fileURLToPath(import.meta.url));
for (const f of [resolve(__dirname, '..', '.env'), resolve(__dirname, '..', '.env.deploy')]) {
  if (existsSync(f)) { try { process.loadEnvFile(f); } catch { /* ignore */ } }
}

const NODE_ADDRESS = requireNode({ cliNode: CLI_NODE });
const SEED = requireEnv('VARA_SEED', 'derives the accounts being swept');
const VARA = 1_000_000_000_000n;
/** Left behind so each account stays usable and above the existential deposit. */
const FLOOR = 2n * VARA;

await waitReady();
const api = await GearApi.create({ providerAddress: NODE_ADDRESS });
const kr = new Keyring({ type: 'sr25519' });
const admin = kr.addFromUri(SEED.trim());

const free = async (addr) => (await api.query.system.account(addr)).data.free.toBigInt();

console.log(`\n  sweeping rehearsal accounts back to admin`);
console.log(`  admin: ${admin.address}  ${(Number(await free(admin.address)) / 1e12).toFixed(3)} VARA\n`);

for (const path of ['//rehearsal-trader', '//rehearsal-keeper']) {
  const who = kr.addFromUri(`${SEED.trim()}${path}`);
  const have = await free(who.address);
  if (have <= FLOOR) {
    console.log(`  ${path}: ${(Number(have) / 1e12).toFixed(3)} VARA, nothing to sweep`);
    continue;
  }
  const send = have - FLOOR;
  process.stdout.write(`  ${path}: returning ${(Number(send) / 1e12).toFixed(3)} VARA … `);
  await new Promise((res, rej) => {
    api.tx.balances
      .transferKeepAlive(admin.address, send)
      .signAndSend(who, ({ status, dispatchError }) => {
        if (dispatchError) return rej(new Error(dispatchError.toString()));
        if (status.isInBlock || status.isFinalized) res();
      })
      .catch(rej);
  });
  console.log('ok');
}

console.log(`\n  admin now: ${(Number(await free(admin.address)) / 1e12).toFixed(3)} VARA\n`);
await api.disconnect();
process.exit(0);
