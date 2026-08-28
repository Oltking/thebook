#!/usr/bin/env node
// End-to-end rehearsal against a REAL node.
//
// ## Why this exists
//
// `gtest` passes on code that cannot run on chain. Two bugs proved it: the gas limit
// passed into `send_for_reply_as`'s value slot, and the gas-estimation RPC trapping
// on any method that awaits a cross-program reply. Both made every escrowing call
// fail on a real node while 26 gtest integration tests stayed green.
//
// So this harness exercises the full money path against an actual Vara node, using
// throwaway test tokens and a throwaway DEX instance. Nothing here touches the
// production program or the real bridged tokens: the tokens it deploys are
// worthless, minted by their own faucet.
//
// It asserts balances at every step, not just that calls succeed, and finishes on
// the solvency invariant.
//
// Usage (from frontend/):
//   NODE_ADDRESS=wss://rpc.vara.network node scripts/rehearsal.mjs
//
// Costs gas on whatever chain you point it at. Run it before every production
// deploy; if it does not pass, the build does not ship.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GearApi } from '@gear-js/api';
import { Keyring } from '@polkadot/api';
import { u8aToHex } from '@polkadot/util';
import { waitReady } from '@polkadot/wasm-crypto';
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
const SEED = requireEnv('VARA_SEED', 'funds the rehearsal');
const DEX_WASM = resolve(repoRoot, 'target/wasm32-gear/release/thebook.opt.wasm');
const TOKEN_WASM = resolve(repoRoot, 'target/wasm32-gear/release/thebook_token.opt.wasm');
const IDL_PATH = resolve(repoRoot, 'client/thebook_client.idl');
const VFT_IDL = resolve(repoRoot, 'sdk/vft.idl');
for (const [p, what] of [[DEX_WASM, 'DEX WASM'], [TOKEN_WASM, 'token WASM'], [IDL_PATH, 'IDL'], [VFT_IDL, 'VFT IDL']]) {
  if (!existsSync(p)) fail(`${what} not found at ${p}. Build: cargo build --release`);
}

const VARA = 1_000_000_000_000n;
const DEC = 6;                       // both rehearsal tokens
const UNIT = 10n ** BigInt(DEC);
const FAUCET = 1_000_000n * UNIT;    // per claim

let failures = 0;
const pass = (m) => console.log(`    ✓ ${m}`);
const check = (cond, m) => { if (cond) pass(m); else { failures += 1; console.log(`    ✗ ${m}`); } };
const eq = (got, want, m) => check(got === want, `${m} (got ${got}, want ${want})`);
const step = (m) => console.log(`\n  ${m}`);

await waitReady();
const api = await GearApi.create({ providerAddress: NODE_ADDRESS });
const parser = await SailsIdlParser.new();
const keyring = new Keyring({ type: 'sr25519' });

// Admin funds and administers. Trader is derived from the same seed so no second
// key has to be created or stored; it needs a little native VARA for its own gas.
const admin = keyring.addFromUri(SEED.trim());
const trader = keyring.addFromUri(`${SEED.trim()}//rehearsal-trader`);
const keeper = keyring.addFromUri(`${SEED.trim()}//rehearsal-keeper`);
const adminId = u8aToHex(admin.addressRaw);
const traderId = u8aToHex(trader.addressRaw);

console.log('\nthebook end-to-end rehearsal');
console.log(`  node:   ${NODE_ADDRESS}`);
console.log(`  admin:  ${admin.address}`);
console.log(`  trader: ${trader.address}`);
console.log(`  keeper: ${keeper.address}`);

const blockMax = api.blockGasLimit.toBigInt();

// Must match the production fallback in src/lib/gas.ts and sdk/thebook.mjs. The
// rehearsal measures real consumption against it, which is how that number is sized.
const FALLBACK_GAS = 20_000_000_000n;
const VALUE_PER_GAS = 100n;

/** Gas: estimate, then fall back on the estimator's known cross-program-wait trap. */
async function prepareGas(tx) {
  try {
    await tx.calculateGas(true);
    return 'estimated';
  } catch (e) {
    if (!/forbidden function/i.test(String(e?.message ?? e))) throw e;
    tx.withGas(FALLBACK_GAS);
    return 'fallback';
  }
}

// Highest observed consumption across the run, so the fallback is sized from
// evidence rather than a hunch.
let peakGas = 0n;
const gasLog = [];
async function freeBalance(addr) {
  const { data } = await api.query.system.account(addr);
  return data.free.toBigInt();
}

async function upload(wasm, initPayload, label) {
  const gas = await api.program.calculateGas.initUpload(adminId, wasm, initPayload, 0, true);
  let limit = (gas.min_limit.toBigInt() * 5n) / 2n;
  if (limit > blockMax) limit = blockMax;
  const { programId, extrinsic } = api.program.upload({ code: wasm, gasLimit: limit, value: 0, initPayload });
  await new Promise((res, rej) => {
    extrinsic.signAndSend(admin, ({ status, events, dispatchError }) => {
      if (dispatchError) {
        // Decode the pallet error rather than printing an opaque module index.
        let detail = dispatchError.toString();
        if (dispatchError.isModule) {
          try {
            const d = api.registry.findMetaError(dispatchError.asModule);
            detail = `${d.section}.${d.name}: ${(d.docs || []).join(' ')}`;
          } catch { /* keep the raw form */ }
        }
        return rej(new Error(`${label}: ${detail}`));
      }
      if (status.isInBlock || status.isFinalized) {
        const failed = events.find(({ event }) => api.events.system.ExtrinsicFailed.is(event));
        return failed ? rej(new Error(`${label}: extrinsic failed`)) : res();
      }
    }).catch(rej);
  });
  return programId;
}

/** Transfer native VARA so a derived account can pay its own gas. */
async function fundNative(to, amount) {
  await new Promise((res, rej) => {
    api.tx.balances.transferKeepAlive(to, amount).signAndSend(admin, ({ status, dispatchError }) => {
      if (dispatchError) return rej(new Error(dispatchError.toString()));
      if (status.isInBlock || status.isFinalized) res();
    }).catch(rej);
  });
}

function sailsFor(idlPath, programId) {
  const s = new Sails(parser);
  s.parseIdl(readFileSync(idlPath, 'utf-8'));
  s.setProgramId(programId);
  s.setApi(api);
  return s;
}

/** Send a program call as `who`, returning the unwrapped ok value or throwing err. */
async function send(sails, service, fn, who, ...args) {
  const tx = sails.services[service].functions[fn](...args);
  tx.withAccount(who, { nonce: -1 });
  const mode = await prepareGas(tx);
  const before = await freeBalance(who.address);
  const { response } = await tx.signAndSend();
  const v = await response();
  // Unused gas is refunded, so the balance delta approximates gas actually burned
  // plus the extrinsic fee. Good enough to size the fallback with headroom.
  const spent = before - (await freeBalance(who.address));
  const gasish = spent > 0n ? spent / VALUE_PER_GAS : 0n;
  if (gasish > peakGas) peakGas = gasish;
  gasLog.push({ call: `${service}.${fn}`, mode, gas: gasish });
  if (v && typeof v === 'object' && 'err' in v) {
    throw new Error(`${service}.${fn} rejected: ${JSON.stringify(v.err)}`);
  }
  return v && typeof v === 'object' && 'ok' in v ? v.ok : v;
}

/** Same, but expects a rejection. Returns the error for inspection. */
async function sendExpectingError(sails, service, fn, who, ...args) {
  try {
    await send(sails, service, fn, who, ...args);
    return null;
  } catch (e) {
    return String(e?.message ?? e);
  }
}

const query = (sails, service, fn, from, ...args) =>
  sails.services[service].queries[fn](...args).withAddress(from).call();

// ── 1 · Deploy throwaway tokens + DEX ───────────────────────────────────────────
step('1 · deploying rehearsal tokens and a throwaway DEX');
const salt = Date.now().toString(16);
const tokenInit = (name, symbol) =>
  u8aToHex(
    api.createType('(String, String, String, u8, U256)', ['New', name, symbol, DEC, FAUCET]).toU8a(),
  );

const BASE = await upload(readFileSync(TOKEN_WASM), tokenInit('Rehearsal Base', `rBASE${salt}`), 'base token');
console.log(`    base  ${BASE}`);
const QUOTE = await upload(readFileSync(TOKEN_WASM), tokenInit('Rehearsal Quote', `rQUOTE${salt}`), 'quote token');
console.log(`    quote ${QUOTE}`);

const dexInit = u8aToHex(api.createType('String', 'New').toU8a());
const DEX = await upload(readFileSync(DEX_WASM), dexInit, 'dex');
console.log(`    dex   ${DEX}`);

const dex = sailsFor(IDL_PATH, DEX);
const base = sailsFor(VFT_IDL, BASE);
const quote = sailsFor(VFT_IDL, QUOTE);

step('    funding the derived trader and keeper for gas');
await fundNative(trader.address, 5n * VARA);
await fundNative(keeper.address, 2n * VARA);
pass('native gas funded');

const bal = async (tok, who) =>
  BigInt((await tok.services.Vft.queries.BalanceOf(who).call()).toString());
const claimOf = async (token, who) => BigInt((await query(dex, 'Spot', 'GetClaim', who, token)).toString());

// ── 2 · Listing verifies decimals on chain (M-14) ───────────────────────────────
step('2 · listing');
const wrongDec = await sendExpectingError(dex, 'Spot', 'ListPair', admin, BASE, QUOTE, 18, DEC);
check(wrongDec !== null && /DecimalsMismatch/.test(wrongDec), 'wrong decimals rejected on chain');
const pairId = await send(dex, 'Spot', 'ListPair', admin, BASE, QUOTE, DEC, DEC);
eq(Number(pairId), 0, 'pair listed');
const reversed = await sendExpectingError(dex, 'Spot', 'ListPair', admin, QUOTE, BASE, DEC, DEC);
check(reversed !== null && /PairExists/.test(reversed), 'reverse orientation rejected');

// ── 3 · Faucets ────────────────────────────────────────────────────────────────
step('3 · claiming faucets');
await send(base, 'Faucet', 'Claim', trader);
await send(quote, 'Faucet', 'Claim', admin);
eq(await bal(base, traderId), FAUCET, 'trader holds base');
eq(await bal(quote, adminId), FAUCET, 'admin holds quote');

// ── 4 · The core path: approve, rest a sell, cross it with a buy ────────────────
step('4 · limit order crossing');
const PRICE = 100n * UNIT;      // 100 quote per whole base
const QTY = 10n * UNIT;         // 10 base
const COST = (PRICE * QTY) / UNIT;

await send(base, 'Vft', 'Approve', trader, DEX, QTY);
const sellId = await send(dex, 'Spot', 'PlaceLimit', trader, pairId, 'Sell', PRICE, QTY);
eq(await bal(base, traderId), FAUCET - QTY, 'sell escrow left the wallet');
pass(`resting sell id=${sellId}`);

const [, asks] = await query(dex, 'Spot', 'GetOrderbook', adminId, pairId, 20);
check(asks.length === 1 && BigInt(asks[0][1]) === QTY, 'ask visible on the book');

await send(quote, 'Vft', 'Approve', admin, DEX, COST);
await send(dex, 'Spot', 'PlaceLimit', admin, pairId, 'Buy', PRICE, QTY);
eq(await claimOf(BASE, adminId), QTY, 'buyer credited the base');
eq(await claimOf(QUOTE, traderId), COST, 'seller credited the quote');
eq(Number(await query(dex, 'Spot', 'RestingOrderCount', adminId)), 0, 'both orders retired from state');

// ── 5 · Withdraw, including a partial (L-01) ───────────────────────────────────
step('5 · withdrawal');
const half = COST / 2n;
await send(dex, 'Spot', 'Withdraw', trader, QUOTE, half);
eq(await bal(quote, traderId), half, 'partial withdrawal reached the wallet');
eq(await claimOf(QUOTE, traderId), COST - half, 'remainder still claimable');
await send(dex, 'Spot', 'Withdraw', trader, QUOTE, null);
eq(await bal(quote, traderId), COST, 'full withdrawal completes');
eq(await claimOf(QUOTE, traderId), 0n, 'claim cleared');
await send(dex, 'Spot', 'Withdraw', admin, BASE, null);
eq(await bal(base, adminId), QTY, 'buyer withdrew the base');

// ── 6 · Cancel refunds escrow exactly ──────────────────────────────────────────
step('6 · cancel');
await send(base, 'Vft', 'Approve', trader, DEX, QTY);
const cancelId = await send(dex, 'Spot', 'PlaceLimit', trader, pairId, 'Sell', PRICE * 2n, QTY);
await send(dex, 'Spot', 'CancelOrder', trader, cancelId);
eq(await claimOf(BASE, traderId), QTY, 'cancel refunded the full escrow');
await send(dex, 'Spot', 'Withdraw', trader, BASE, null);
eq(await bal(base, traderId), FAUCET - QTY, 'refund reached the wallet');

// ── 7 · Market order slippage bound returns the escrow (H-03) ──────────────────
step('7 · slippage bound');
await send(base, 'Vft', 'Approve', trader, DEX, QTY);
const before7 = await bal(base, traderId);
const slipped = await sendExpectingError(
  dex, 'Spot', 'MarketSell', trader, pairId, QTY, (COST * 10n).toString(),
);
check(slipped !== null && /SlippageExceeded/.test(slipped), 'unmeetable bound rejected');
eq(await claimOf(BASE, traderId), QTY, 'rejected market sell returned the escrow');
await send(dex, 'Spot', 'Withdraw', trader, BASE, null);
eq(await bal(base, traderId), before7, 'trader made whole');

// ── 8 · Pause never traps funds (H-08) ─────────────────────────────────────────
step('8 · pause');
await send(base, 'Vft', 'Approve', trader, DEX, QTY);
const pausedOrder = await send(dex, 'Spot', 'PlaceLimit', trader, pairId, 'Sell', PRICE, QTY);
await send(dex, 'Spot', 'SetPaused', admin, true);
const blocked = await sendExpectingError(dex, 'Spot', 'PlaceLimit', trader, pairId, 'Sell', PRICE, QTY);
check(blocked !== null && /Paused/.test(blocked), 'paused venue refuses new orders');
await send(dex, 'Spot', 'CancelOrder', trader, pausedOrder);
pass('cancel works while paused');
await send(dex, 'Spot', 'Withdraw', trader, BASE, null);
pass('withdraw works while paused');
await send(dex, 'Spot', 'SetPaused', admin, false);
pass('unpaused');

// ── 9 · Perps: fund, open, close, settle (C-03, M-04) ──────────────────────────
step('9 · perps');
await send(dex, 'PerpsV1', 'SetCollateral', admin, QUOTE);
await send(dex, 'PerpsV1', 'SetKeeper', admin, u8aToHex(keeper.addressRaw));
const marketId = await send(dex, 'PerpsV1', 'AddMarket', admin, 'REHEARSAL', (10n ** 15n).toString());
pass(`market id=${marketId}`);

const MARK = 2000n;
await send(dex, 'PerpsV1', 'SetMark', keeper, marketId, MARK);
pass('keeper published a mark');
const adminIsNotKeeper = await sendExpectingError(dex, 'PerpsV1', 'SetMark', admin, marketId, MARK);
check(adminIsNotKeeper !== null && /NotKeeper/.test(adminIsNotKeeper), 'admin is not an implicit keeper');
const wildMark = await sendExpectingError(dex, 'PerpsV1', 'SetMark', keeper, marketId, MARK * 3n);
check(wildMark !== null && /MarkDeviationTooLarge/.test(wildMark), 'mark deviation bound holds');

// Unbacked open must be refused: the reserve is still empty.
await send(quote, 'Vft', 'Approve', trader, DEX, 1000n * UNIT);
await send(quote, 'Faucet', 'Claim', trader).catch(() => {});
const unbacked = await sendExpectingError(dex, 'PerpsV1', 'OpenPosition', trader, marketId, true, (100n * UNIT).toString(), 2);
check(unbacked !== null && /InsufficientCoverage/.test(unbacked), 'open refused against an empty reserve');

// Fund the reserve, then open for real.
const RESERVE = 100_000n * UNIT;
await send(quote, 'Vft', 'Approve', admin, DEX, RESERVE);
await send(dex, 'PerpsV1', 'FundReserve', admin, RESERVE.toString());
eq(BigInt((await dex.services.PerpsV1.queries.GetReserve().call()).toString()), RESERVE, 'reserve funded');

const MARGIN = 1000n * UNIT;
await send(quote, 'Vft', 'Approve', trader, DEX, MARGIN);
const traderQuoteBefore = await bal(quote, traderId);
const posId = await send(dex, 'PerpsV1', 'OpenPosition', trader, marketId, true, MARGIN.toString(), 5);
eq(await bal(quote, traderId), traderQuoteBefore - MARGIN, 'margin left the wallet');
pass(`position id=${posId} opened at 5x`);

const tooMuchLeverage = await sendExpectingError(dex, 'PerpsV1', 'OpenPosition', trader, marketId, true, MARGIN.toString(), 6);
check(tooMuchLeverage !== null && /LeverageTooHigh/.test(tooMuchLeverage), 'leverage capped at 5x');

// Move the mark up 5% and close in profit.
await send(dex, 'PerpsV1', 'SetMark', keeper, marketId, (MARK * 105n) / 100n);
const closed = await send(dex, 'PerpsV1', 'ClosePosition', trader, posId);
const payout = BigInt(String(Array.isArray(closed) ? closed[0] : closed));
check(payout > MARGIN, `profitable close paid out more than margin (${payout} > ${MARGIN})`);
eq(await claimOf(QUOTE, traderId), payout, 'payout is claimable');
await send(dex, 'Spot', 'Withdraw', trader, QUOTE, null);
pass('perp payout withdrawn to the wallet');

// ── 10 · Solvency invariant ────────────────────────────────────────────────────
step('10 · solvency');
for (const [label, tok, id] of [['base', base, BASE], ['quote', quote, QUOTE]]) {
  const [escrow, dust, reserve] = await dex.services.Spot.queries.GetSolvency(id).call();
  const held = await bal(tok, DEX);
  let claims = 0n;
  for (const who of [adminId, traderId]) claims += await claimOf(id, who);
  const owed = BigInt(escrow) + BigInt(dust) + BigInt(reserve) + claims;
  check(held >= owed, `${label}: held ${held} >= claims+escrow+dust+reserve ${owed}`);
}

console.log(`\n${failures === 0
  ? '  ✓ REHEARSAL PASSED — the full money path works on a real node\n'
  : `  ✗ REHEARSAL FAILED — ${failures} check(s) did not pass\n`}`);
console.log('  gas consumed (approx, from balance delta):');
for (const g of [...gasLog].sort((a, b) => Number(b.gas - a.gas)).slice(0, 8)) {
  console.log(`    ${String(g.gas).padStart(14)}  ${g.mode.padEnd(9)} ${g.call}`);
}
console.log(`  peak ${peakGas} vs fallback ${FALLBACK_GAS}`);
if (peakGas * 2n > FALLBACK_GAS) {
  console.log('    ! under 2x headroom - raise FALLBACK_GAS in src/lib/gas.ts and sdk/thebook.mjs');
}

console.log(`\n  throwaway artifacts (safe to ignore):\n    dex   ${DEX}\n    base  ${BASE}\n    quote ${QUOTE}\n`);

await api.disconnect();
process.exit(failures === 0 ? 0 : 1);
