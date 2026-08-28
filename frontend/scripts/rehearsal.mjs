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

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GearApi } from '@gear-js/api';
import { Keyring } from '@polkadot/api';
import { u8aToHex, u8aConcat, stringToU8a, compactToU8a } from '@polkadot/util';
import { randomAsU8a } from '@polkadot/util-crypto';
import { generateCodeHash } from '@gear-js/api';
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

// The BASE side is the REAL bridged wVARA program. That is the point of this
// harness: the DEX escrows by messaging a token program someone else wrote, and
// only a real token proves that path works. Native VARA is wrapped into it via
// `VftNativeExchange/Mint`, so no bridged balance has to be acquired first.
const WVARA = '0x29c42c668012b1ce20720e4615229215023281ef4676fdc77bf047d7fbcb9d17';
const BASE_DEC = 12;
const BASE_UNIT = 10n ** BigInt(BASE_DEC);

// The QUOTE side is a throwaway test token. Its constructor pre-allocates balance
// shards at ~49 VARA, so it is cached and reused rather than redeployed. Using
// different decimals on each side is deliberate: `notional` scales by `base_dec`,
// and a 12/6 pair exercises that where a 6/6 pair would not.
const QUOTE_DEC = 6;
const QUOTE_UNIT = 10n ** BigInt(QUOTE_DEC);
const FAUCET = 1_000_000n * QUOTE_UNIT;

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

// Measured: an escrowing call burns ~0.8 VARA and must be able to RESERVE
// FALLBACK_GAS * valuePerGas (3 VARA) before it will even submit. A full run makes
// roughly 35 of them across three accounts. Dying half way through leaves throwaway
// state on chain and wastes everything spent so far, so check up front.
const RUN_COST_ESTIMATE = 55n * VARA;
{
  const { data } = await api.query.system.account(admin.address);
  const free = data.free.toBigInt();
  if (free < RUN_COST_ESTIMATE) {
    fail(
      `admin holds ${Number(free) / 1e12} VARA; a full run needs about ` +
      `${Number(RUN_COST_ESTIMATE) / 1e12}.\n` +
      '    Each cross-program call burns ~0.8 VARA and reserves 3 while it runs.\n' +
      '    Recover leftovers first: node scripts/sweep-derived.mjs',
    );
  }
  console.log(`  admin:  ${Number(free) / 1e12} VARA available`);
}

// Must match the production fallback in src/lib/gas.ts and sdk/thebook.mjs. The
// rehearsal measures real consumption against it, which is how that number is sized.
const FALLBACK_GAS = 30_000_000_000n;
const VALUE_PER_GAS = 100n;

/** Gas: estimate, then fall back on the estimator's known cross-program-wait trap. */
async function prepareGas(tx) {
  try {
    // The node returns the MINIMUM viable limit. Any variance between
    // estimating and executing busts it, so pad by 100%. Unused gas
    // is refunded, so the padding costs nothing.
    await tx.calculateGas(true, 100);
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

/**
 * Instantiate a program, reusing code already on chain where possible.
 *
 * `uploadProgram` carries the whole WASM and fails outright if that code is already
 * stored, which is both expensive and a hard error when deploying two instances of
 * the same token. Uploading the code once and then creating instances from its
 * `codeId` is cheaper and idempotent.
 */
async function instantiate(wasm, initPayload, label) {
  const codeId = generateCodeHash(wasm);
  const codeOnChain = await api.code.exists(codeId).catch(() => false);

  if (!codeOnChain) {
    const { extrinsic: codeTx } = await api.code.upload(wasm);
    await signSend(codeTx, `${label}: code upload`);
  }

  const salt = u8aToHex(randomAsU8a(8));
  const gas = await api.program.calculateGas.initCreate(adminId, codeId, initPayload, 0, true);
  let limit = (gas.min_limit.toBigInt() * 5n) / 2n;
  if (limit > blockMax) limit = blockMax;
  const { programId, extrinsic } = api.program.create({ codeId, salt, gasLimit: limit, value: 0, initPayload });
  await signSend(extrinsic, label);
  return programId;
}

/** Sign, send, and reject with a decoded pallet error rather than a module index. */
const signSend = (extrinsic, label) => signSendAs(extrinsic, admin, label);

function signSendAs(extrinsic, who, label) {
  return new Promise((res, rej) => {
    extrinsic.signAndSend(who, ({ status, events, dispatchError }) => {
      if (dispatchError) {
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
}

/** Ensure `who` holds at least `target` native VARA, sending only the shortfall. */
async function topUpTo(who, target) {
  const { data } = await api.query.system.account(who.address);
  const have = data.free.toBigInt();
  if (have >= target) {
    console.log(`      ${who.address.slice(0, 8)}… has ${Number(have) / 1e12} VARA, no top-up`);
    return;
  }
  const need = target - have;
  console.log(`      topping ${who.address.slice(0, 8)}… up by ${Number(need) / 1e12} VARA`);
  await fundNative(who.address, need);
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

/**
 * Wrap native VARA into real wVARA.
 *
 * The wVARA program exposes `VftNativeExchange/Mint`, which is payable: the native
 * value attached to the message becomes the minted VFT balance, 1:1. `Burn(amount)`
 * reverses it. Both were confirmed against the live program.
 */
async function wrapVara(who, amount) {
  const payload = u8aToHex(u8aConcat(
    compactToU8a('VftNativeExchange'.length), stringToU8a('VftNativeExchange'),
    compactToU8a('Mint'.length), stringToU8a('Mint'),
  ));
  const gas = await api.program.calculateGas.handle(
    u8aToHex(who.addressRaw), WVARA, payload, amount, true);
  const limit = (gas.min_limit.toBigInt() * 5n) / 2n;
  await signSendAs(api.message.send({ destination: WVARA, payload, gasLimit: limit, value: amount }), who, 'wrap VARA');
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

/** Turn a raw submission failure into something that names itself. */
function explain(e) {
  const m = String(e?.message ?? e);
  if (/InsufficientBalance/.test(m)) {
    return `${m} (signer cannot reserve the gas limit; fund it with more native VARA)`;
  }
  return m;
}

/** Same, but expects a rejection. Returns the error for inspection. */
async function sendExpectingError(sails, service, fn, who, ...args) {
  try {
    await send(sails, service, fn, who, ...args);
    return null;
  } catch (e) {
    return explain(e);
  }
}

const query = (sails, service, fn, from, ...args) =>
  sails.services[service].queries[fn](...args).withAddress(from).call();

// ── 1 · Deploy throwaway tokens + DEX ───────────────────────────────────────────
//
// The test token's constructor pre-allocates balance/allowance shards, which costs
// roughly 493 billion gas (~49 VARA) per instance. That is the single most expensive
// thing here, so token addresses are cached and reused across runs: the first run
// pays for them, every later run costs almost nothing. The DEX is redeployed every
// time, because testing the current build is the entire point, and its init is cheap
// (~1.2 billion gas).
step('1 · rehearsal tokens and a throwaway DEX');
const CACHE = resolve(__dirname, '.rehearsal-tokens.json');
const salt = Date.now().toString(16);
const tokenInit = (name, symbol) =>
  u8aToHex(
    api.createType('(String, String, String, u8, U256)', ['New', name, symbol, QUOTE_DEC, FAUCET]).toU8a(),
  );

let cached = {};
if (existsSync(CACHE)) {
  try { cached = JSON.parse(readFileSync(CACHE, 'utf-8')); } catch { cached = {}; }
}
async function tokenFor(key, label) {
  const known = process.env[`REHEARSAL_${key.toUpperCase()}`] || cached[key];
  if (known) {
    // Confirm it is really there before trusting the cache.
    try {
      await sailsFor(VFT_IDL, known).services.VftMetadata.queries.Decimals().call();
      console.log(`    ${label.padEnd(5)} ${known} (reused)`);
      return known;
    } catch {
      console.log(`    ${label} cached address unreachable, redeploying`);
    }
  }
  const id = await instantiate(
    readFileSync(TOKEN_WASM), tokenInit(`Rehearsal ${label}`, `r${label}${salt}`), `${label} token`);
  cached[key] = id;
  writeFileSync(CACHE, JSON.stringify(cached, null, 2));
  console.log(`    ${label.padEnd(5)} ${id} (new)`);
  return id;
}

// BASE is the real bridged wVARA program, not something we deploy.
const BASE = WVARA;
console.log(`    BASE  ${BASE} (real bridged wVARA)`);
const QUOTE = await tokenFor('quote', 'QUOTE');

const dexInit = u8aToHex(api.createType('String', 'New').toU8a());
const DEX = await instantiate(readFileSync(DEX_WASM), dexInit, 'dex');
console.log(`    dex   ${DEX}`);

const dex = sailsFor(IDL_PATH, DEX);
const base = sailsFor(VFT_IDL, BASE);
const quote = sailsFor(VFT_IDL, QUOTE);

// Each escrowing call reserves FALLBACK_GAS * valuePerGas (3 VARA) for the duration
// of the transaction, refunded on completion. The trader makes ~20 of them, and the
// reservation cannot be made at all if free balance is below it - which surfaces as
// `gearBank.InsufficientBalance`, not as anything mentioning gas. Fund generously;
// both accounts derive from the same seed, so the remainder is recoverable.
// Top up to a target rather than transferring a fixed amount every run: the derived
// accounts keep their balance between runs, so re-sending would drain admin into
// them for no reason. Nothing is lost either way (same seed), but admin is the one
// that has to afford the deploy.
step('    topping up the derived trader and keeper for gas');
await topUpTo(trader, 25n * VARA);
await topUpTo(keeper, 4n * VARA);
pass('native gas available');

const bal = async (tok, who) =>
  BigInt((await tok.services.Vft.queries.BalanceOf(who).call()).toString());
const claimOf = async (token, who) => BigInt((await query(dex, 'Spot', 'GetClaim', who, token)).toString());

// ── 2 · Listing verifies decimals on chain (M-14) ───────────────────────────────
step('2 · listing');
const wrongDec = await sendExpectingError(dex, 'Spot', 'ListPair', admin, BASE, QUOTE, 18, QUOTE_DEC);
check(wrongDec !== null && /DecimalsMismatch/.test(wrongDec),
  'wrong decimals rejected against the real token metadata');
const pairId = await send(dex, 'Spot', 'ListPair', admin, BASE, QUOTE, BASE_DEC, QUOTE_DEC);
eq(Number(pairId), 0, 'pair listed (real wVARA base, 12 dec)');
const reversed = await sendExpectingError(dex, 'Spot', 'ListPair', admin, QUOTE, BASE, QUOTE_DEC, BASE_DEC);
check(reversed !== null && /PairExists/.test(reversed), 'reverse orientation rejected');

// ── 3 · Faucets ────────────────────────────────────────────────────────────────
// The DEX is fresh every run but tokens and accounts persist, so this tops up to
// what the run needs instead of assuming empty wallets. Every later assertion is a
// delta against a snapshot for the same reason.
step('3 · funding: wrap real wVARA, claim the throwaway quote');
const NEED_BASE = 4n * BASE_UNIT;
const NEED_QUOTE = 10n * QUOTE_UNIT;

const baseHeld = await bal(base, traderId);
if (baseHeld < NEED_BASE) {
  await wrapVara(trader, NEED_BASE - baseHeld);
}
check(await bal(base, traderId) >= NEED_BASE, 'trader holds enough REAL wVARA (wrapped from native)');

if (await bal(quote, adminId) < NEED_QUOTE) {
  // One claim per account; already having claimed is not a failure.
  const claimed = await sendExpectingError(quote, 'Faucet', 'Claim', admin);
  if (claimed && !/AlreadyClaimed/.test(claimed)) fail(`quote faucet: ${claimed}`);
}
check(await bal(quote, adminId) >= NEED_QUOTE, 'admin holds enough quote');

// ── 4 · The core path: approve, rest a sell, cross it with a buy ────────────────
step('4 · limit order crossing');
const PRICE = 2n * QUOTE_UNIT;   // 2 quote per whole base
const QTY = 1n * BASE_UNIT;      // 1 wVARA
const COST = (PRICE * QTY) / BASE_UNIT;

const traderBase0 = await bal(base, traderId);
const adminBase0 = await bal(base, adminId);
await send(base, 'Vft', 'Approve', trader, DEX, QTY);
const sellId = await send(dex, 'Spot', 'PlaceLimit', trader, pairId, 'Sell', PRICE, QTY);
eq(await bal(base, traderId), traderBase0 - QTY, 'sell escrow left the wallet (real token TransferFrom)');
pass(`resting sell id=${sellId}`);

const [, asks] = await query(dex, 'Spot', 'GetOrderbook', adminId, pairId, 20);
check(asks.length === 1 && BigInt(asks[0][1]) === QTY, 'ask visible on the book');

await send(quote, 'Vft', 'Approve', admin, DEX, COST);
await send(dex, 'Spot', 'PlaceLimit', admin, pairId, 'Buy', PRICE, QTY);
eq(await claimOf(BASE, adminId), QTY, 'buyer credited the base');
eq(await claimOf(QUOTE, traderId), COST, 'seller credited the quote');
check(true, 'crossing settled through claimable balances');
eq(Number(await query(dex, 'Spot', 'RestingOrderCount', adminId)), 0, 'both orders retired from state');

// ── 5 · Withdraw, including a partial (L-01) ───────────────────────────────────
step('5 · withdrawal');
const traderQuote0 = await bal(quote, traderId);
const half = COST / 2n;
await send(dex, 'Spot', 'Withdraw', trader, QUOTE, half);
eq(await bal(quote, traderId), traderQuote0 + half, 'partial withdrawal reached the wallet');
eq(await claimOf(QUOTE, traderId), COST - half, 'remainder still claimable');
await send(dex, 'Spot', 'Withdraw', trader, QUOTE, null);
eq(await bal(quote, traderId), traderQuote0 + COST, 'full withdrawal completes');
eq(await claimOf(QUOTE, traderId), 0n, 'claim cleared');
await send(dex, 'Spot', 'Withdraw', admin, BASE, null);
eq(await bal(base, adminId), adminBase0 + QTY, 'buyer withdrew the base');

// ── 6 · Cancel refunds escrow exactly ──────────────────────────────────────────
step('6 · cancel');
const traderBase6 = await bal(base, traderId);
await send(base, 'Vft', 'Approve', trader, DEX, QTY);
const cancelId = await send(dex, 'Spot', 'PlaceLimit', trader, pairId, 'Sell', PRICE * 2n, QTY);
await send(dex, 'Spot', 'CancelOrder', trader, cancelId);
eq(await claimOf(BASE, traderId), QTY, 'cancel refunded the full escrow');
await send(dex, 'Spot', 'Withdraw', trader, BASE, null);
eq(await bal(base, traderId), traderBase6, 'refund reached the wallet');

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
// The trader needs quote to post perp margin; the faucet is one claim per account.
if (await bal(quote, traderId) < 2000n * QUOTE_UNIT) {
  const c = await sendExpectingError(quote, 'Faucet', 'Claim', trader);
  if (c && !/AlreadyClaimed/.test(c)) fail(`trader quote faucet: ${c}`);
}
await send(quote, 'Vft', 'Approve', trader, DEX, 1000n * QUOTE_UNIT);
const unbacked = await sendExpectingError(dex, 'PerpsV1', 'OpenPosition', trader, marketId, true, (100n * QUOTE_UNIT).toString(), 2);
check(unbacked !== null && /InsufficientCoverage/.test(unbacked), 'open refused against an empty reserve');

// Fund the reserve, then open for real.
const RESERVE = 100_000n * QUOTE_UNIT;
await send(quote, 'Vft', 'Approve', admin, DEX, RESERVE);
await send(dex, 'PerpsV1', 'FundReserve', admin, RESERVE.toString());
eq(BigInt((await dex.services.PerpsV1.queries.GetReserve().call()).toString()), RESERVE, 'reserve funded');

const MARGIN = 1000n * QUOTE_UNIT;
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

// ── 10 · AMM: real pools over the real bridged token ───────────────────────────
step('10 · amm');
const poolId = await send(dex, 'Amm', 'CreatePool', admin, BASE, QUOTE, BASE_DEC, QUOTE_DEC);
pass(`pool id=${poolId} (real wVARA / throwaway quote)`);
const badDec = await sendExpectingError(dex, 'Amm', 'CreatePool', admin, BASE, QUOTE, 18, QUOTE_DEC);
check(badDec !== null, 'duplicate pair rejected');

// Seed it from the trader, who holds both sides.
const SEED_A = 1n * BASE_UNIT;        // 1 wVARA
const SEED_B = 2n * QUOTE_UNIT;       // 2 quote, so the pool prices wVARA at 2
await send(base, 'Vft', 'Approve', trader, DEX, SEED_A);
await send(quote, 'Vft', 'Approve', trader, DEX, SEED_B);
const traderBaseAmm = await bal(base, traderId);
const shares = await send(dex, 'Amm', 'AddLiquidity', trader, poolId, SEED_A, SEED_B, 0);
check(BigInt(shares) > 0n, `minted ${shares} LP shares`);
eq(await bal(base, traderId), traderBaseAmm - SEED_A, 'deposit left the wallet (real token)');

const [held0] = await query(dex, 'Amm', 'GetPosition', traderId, poolId);
check(BigInt(held0) === BigInt(shares), 'position reports the minted shares');

/**
 * Liquidity backing one share, as sqrt(k) / total_shares.
 *
 * Comparing the two reserves directly does not work: a one-directional swap moves
 * the pool along the curve, so the base side falls while the quote side rises, and
 * whether that looks like a gain depends entirely on the price you value them at.
 * sqrt(reserve_a * reserve_b) is the pool's own invariant and is price-independent,
 * so growth in it per share is exactly the fee accrual and nothing else.
 */
const isqrt = (n) => {
  if (n <= 1n) return n;
  let x = n; let y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
};
async function backingPerShare(id) {
  const p = await query(dex, 'Amm', 'GetPool', adminId, id);
  const pool = Array.isArray(p) ? p[0] : p;
  const k = BigInt(pool.reserve_a) * BigInt(pool.reserve_b);
  // Scaled so integer division does not flatten the difference.
  return (isqrt(k) * 1_000_000_000n) / BigInt(pool.total_shares);
}
const backing0 = await backingPerShare(poolId);

// Admin trades against the pool. Each leg leaves 0.3% behind.
await send(quote, 'Vft', 'Approve', admin, DEX, 400_000n);
for (let i = 0; i < 3; i += 1) {
  const out = await send(dex, 'Amm', 'Swap', admin, poolId, QUOTE, 100_000n, 0);
  check(BigInt(out) > 0n, `swap ${i + 1} returned ${out} base`);
}

// The whole design claim: the same shares are backed by more liquidity afterwards,
// measured on the pool's own invariant so no price assumption creeps in.
const [held1] = await query(dex, 'Amm', 'GetPosition', traderId, poolId);
eq(BigInt(held1), BigInt(held0), 'share count unchanged by trading');
const backing1 = await backingPerShare(poolId);
check(
  backing1 > backing0,
  `liquidity backing each share grew with fees (${backing0} -> ${backing1})`,
);

// An unmeetable bound must not burn shares.
const badRemove = await sendExpectingError(
  dex, 'Amm', 'RemoveLiquidity', trader, poolId, held1, (2n ** 120n).toString(), 0);
check(badRemove !== null && /SlippageExceeded/.test(badRemove), 'unmeetable removal bound rejected');
const [stillHeld] = await query(dex, 'Amm', 'GetPosition', traderId, poolId);
eq(BigInt(stillHeld), BigInt(held1), 'rejected removal burned nothing');

// Removing liquidity works even while paused: a provider must always be able to exit.
await send(dex, 'Spot', 'SetPaused', admin, true);
const pausedSwap = await sendExpectingError(dex, 'Amm', 'Swap', admin, poolId, QUOTE, 1000n, 0);
check(pausedSwap !== null && /Paused/.test(pausedSwap), 'paused venue refuses swaps');
const [outA, outB] = await send(dex, 'Amm', 'RemoveLiquidity', trader, poolId, held1, 0, 0);
pass(`removed liquidity while paused: ${outA} base, ${outB} quote`);
await send(dex, 'Spot', 'SetPaused', admin, false);
check(BigInt(outA) > 0n && BigInt(outB) > 0n, 'both sides returned');
await send(dex, 'Spot', 'Withdraw', trader, BASE, null);
await send(dex, 'Spot', 'Withdraw', trader, QUOTE, null);
pass('LP proceeds withdrawn to the wallet');

// ── 11 · Solvency invariant ────────────────────────────────────────────────────
step('11 · solvency');
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
for (const [label, who] of [['admin', admin], ['trader', trader], ['keeper', keeper]]) {
  const { data } = await api.query.system.account(who.address);
  console.log(`  ${label.padEnd(7)} ends with ${(Number(data.free.toBigInt()) / 1e12).toFixed(3)} VARA`);
}
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
