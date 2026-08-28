// Fund the perps house reserve (optional, admin only).
//
// The reserve pays out perp profits. Funding it moves USD from the admin's own
// DEX balance into the reserve. Virtual-balance model: Join grants the admin its
// starting USD, so this just Joins (idempotent) then calls FundReserve. Futures
// open/close without this; the reserve matters once winning positions need large
// payouts.
//
// Usage (from frontend/, after deploy + setting VITE_* in .env):
//   VARA_SEED="<admin seed>" node scripts/fund-reserve.mjs
//
// AMOUNT is in the COLLATERAL TOKEN's smallest units, not cents. wUSDT/wUSDC are
// 6 decimals, so 1000 USDT is AMOUNT=1000000000.
//
// The collateral token is read from the contract (PerpsV1/GetConfig), so it cannot
// disagree with what the contract will actually pull.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { GearApi, decodeAddress } from '@gear-js/api';
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
for (const f of [resolve(__dirname, '..', '.env'), resolve(__dirname, '..', '.env.deploy')]) {
  if (existsSync(f)) { try { process.loadEnvFile(f); } catch { /* ignore */ } }
}

// Required, no default: this script signs (audit H-09).
const NODE_ADDRESS = requireNode({ cliNode: CLI_NODE });
const SEED = process.env.VARA_SEED;
const THEBOOK_ID = process.env.THEBOOK_ID ?? process.env.PROGRAM_ID ?? process.env.VITE_PROGRAM_ID;
const IDL_PATH = process.env.IDL_PATH ?? resolve(repoRoot, 'client/thebook_client.idl');
const AMOUNT = BigInt(process.env.AMOUNT ?? '0');
if (AMOUNT <= 0n) fail('AMOUNT is required (collateral smallest-units; wUSDT is 6 decimals).');

function fail(m) { console.error(`\n  ✗ ${m}\n`); process.exit(1); }
if (!SEED) fail('VARA_SEED is required (the admin seed).');
if (!THEBOOK_ID) fail('VITE_PROGRAM_ID (the DEX id) is required.');

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
sails.setProgramId(THEBOOK_ID);

console.log(`\n  fund perps reserve`);
console.log(`  ──────────────────`);
console.log(`  admin:  ${admin.address}`);
console.log(`  amount: ${AMOUNT} (collateral smallest-units)\n`);

/** Sails route payload: String(service) + String(method) + encoded args. */
function route(service, method, argsU8a = new Uint8Array()) {
  return u8aToHex(u8aConcat(
    api.createType('String', service).toU8a(),
    api.createType('String', method).toU8a(),
    argsU8a,
  ));
}

/** Send a raw message to a program and wait for inclusion. */
async function sendRaw(dest, payload, label) {
  const gas = await api.program.calculateGas.handle(sourceId, dest, payload, 0, true);
  let limit = gas.min_limit.toBigInt() * 3n;
  if (limit > blockMax) limit = blockMax;
  const ext = api.message.send({ destination: dest, payload, gasLimit: limit, value: 0 });
  await new Promise((res, rej) => {
    ext.signAndSend(admin, ({ status, events, dispatchError }) => {
      if (dispatchError) return rej(new Error(`${label}: ${dispatchError.toString()}`));
      if (status.isInBlock || status.isFinalized) {
        const failed = events.find(({ event }) => api.events.system.ExtrinsicFailed.is(event));
        failed ? rej(new Error(`${label}: extrinsic failed`)) : res();
      }
    }).catch(rej);
  });
}

/** Send a VFT call (e.g. Approve) to a token program as the admin. */
async function callVft(token, fn, ...args) {
  const vft = new Sails(parser);
  vft.parseIdl(readFileSync(resolve(repoRoot, 'sdk/vft.idl'), 'utf8'));
  vft.setProgramId(token);
  vft.setApi(api);
  const tx = vft.services.Vft.functions[fn](...args);
  tx.withAccount(admin);
  await prepareGas(tx);
  const { response } = await tx.signAndSend();
  return response();
}

/** Estimate, padding by 100%; fall back on the estimator's cross-program-wait trap. */
async function prepareGas(tx) {
  try {
    await tx.calculateGas(true, 100);
  } catch (e) {
    if (!/forbidden function/i.test(String(e?.message ?? e))) throw e;
    tx.withGas(30_000_000_000n);
  }
}

async function callDex(service, fn, ...args) {
  const tx = sails.services[service].functions[fn](...args);
  tx.withAccount(admin);
  await prepareGas(tx);
  const { response } = await tx.signAndSend();
  return response();
}

// The reserve is REAL collateral now: the admin approves the DEX to pull `AMOUNT`
// of the collateral token, then funds. There is no `Join` and no granted balance —
// that was the virtual-balance path removed in audit C-02.
// Read the collateral token from the contract rather than trusting an env var:
// funding the wrong token would approve and transfer into a reserve that never
// counts, with no error to say so.
const [COLLATERAL] = await sails.services.PerpsV1.queries.GetConfig().call();
if (!COLLATERAL || /^0x0+$/.test(String(COLLATERAL))) {
  fail('perps collateral is not set on this program (PerpsV1/SetCollateral first).');
}
console.log(`  collateral token: ${COLLATERAL}`);

// Refuse to start if the admin cannot cover it; a half-done funding is confusing.
{
  const vft = new Sails(parser);
  vft.parseIdl(readFileSync(resolve(repoRoot, 'sdk/vft.idl'), 'utf8'));
  vft.setProgramId(String(COLLATERAL));
  vft.setApi(api);
  const held = BigInt((await vft.services.Vft.queries.BalanceOf(sourceId).call()).toString());
  console.log(`  admin holds:      ${held}`);
  if (held < AMOUNT) {
    fail(`admin holds ${held} of the collateral token but is funding ${AMOUNT}.`);
  }
}

process.stdout.write(`  approving ${AMOUNT} to the DEX … `);
await callVft(COLLATERAL, 'Approve', THEBOOK_ID, AMOUNT.toString());
console.log('ok');

process.stdout.write('  funding reserve … ');
await callDex('PerpsV1', 'FundReserve', AMOUNT.toString());
console.log('ok');

const reserve = await sails.services.PerpsV1.queries.GetReserve().call();
console.log(`\n  ✓ reserve funded. On-chain reserve is now ${reserve}\n`);
console.log('  Perps open for trading once the keeper starts publishing marks:');
console.log('    KEEPER_SEED=… NODE_ADDRESS=wss://rpc.vara.network node scripts/perps-keeper.mjs\n');
await api.disconnect();
process.exit(0);
