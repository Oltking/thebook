// Fund the perps house reserve (optional, admin only).
//
// The reserve pays out perp profits. Funding it moves USD from the admin's own
// DEX balance into the reserve, so this first claims wUSDC from the faucet,
// approves + deposits it, then calls FundReserve. Futures open/close without
// this; the reserve matters once winning positions need large payouts.
//
// Usage (from frontend/, after deploy-all + setting VITE_* in .env):
//   VARA_SEED="<admin seed>" node scripts/fund-reserve.mjs
//
// Optional: AMOUNT (USD cents, default 100000 = the faucet's wUSDC amount).

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { GearApi, decodeAddress } from '@gear-js/api';
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
const THEBOOK_ID = process.env.THEBOOK_ID ?? process.env.PROGRAM_ID ?? process.env.VITE_PROGRAM_ID;
const USD_TOKEN = process.env.VITE_TOKEN_USD;
const IDL_PATH = process.env.IDL_PATH ?? resolve(repoRoot, 'client/thebook_client.idl');
const AMOUNT = BigInt(process.env.AMOUNT ?? '100000');

function fail(m) { console.error(`\n  ✗ ${m}\n`); process.exit(1); }
if (!SEED) fail('VARA_SEED is required (the admin seed).');
if (!THEBOOK_ID) fail('VITE_PROGRAM_ID (the DEX id) is required.');
if (!USD_TOKEN || /^0x0+$/.test(USD_TOKEN)) fail('VITE_TOKEN_USD is required (run deploy-all first).');

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
console.log(`  amount: ${AMOUNT} (cents)\n`);

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

async function callDex(service, fn, ...args) {
  const tx = sails.services[service].functions[fn](...args);
  tx.withAccount(admin);
  await tx.calculateGas(true);
  const { response } = await tx.signAndSend();
  return response();
}

// 0 · make sure the admin has a DEX account (Join is idempotent)
process.stdout.write('  registering admin (Join) … ');
try { await callDex('Orderbook', 'Join', 'admin', 'ArbitrageHunter'); console.log('ok'); }
catch (e) { console.log(`(already joined or ${String(e?.message || e).slice(0, 40)})`); }

// 1 · claim wUSDC from the token faucet
process.stdout.write('  claiming wUSDC … ');
await sendRaw(USD_TOKEN, route('Faucet', 'Claim'), 'claim');
console.log('ok');

// 2 · approve the DEX to pull the wUSDC
process.stdout.write('  approving DEX … ');
const approveArgs = api.createType('([u8;32], U256)', [u8aToHex(decodeAddress(THEBOOK_ID)), AMOUNT]).toU8a();
await sendRaw(USD_TOKEN, route('Vft', 'Approve', approveArgs), 'approve');
console.log('ok');

// 3 · deposit into the DEX vault (credits admin USD balance)
process.stdout.write('  depositing USD … ');
await callDex('Orderbook', 'Deposit', 'Usd', AMOUNT.toString());
console.log('ok');

// 4 · move it into the house reserve
process.stdout.write('  funding reserve … ');
await callDex('Perps', 'FundReserve', AMOUNT.toString());
console.log('ok');

console.log(`\n  ✓ reserve funded with ${AMOUNT} cents\n`);
await api.disconnect();
process.exit(0);
