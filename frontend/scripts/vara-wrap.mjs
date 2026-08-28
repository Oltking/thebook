#!/usr/bin/env node
/**
 * Convert between native VARA and wVARA on Vara mainnet.
 *
 * Standalone: it does not import anything from this repository, so it can be copied
 * into any directory on its own.
 *
 * ## Why this is needed
 *
 * Native VARA pays gas. wVARA is the VFT token that exchanges, pools and contracts
 * actually understand. They convert 1:1 through the wVARA program's
 * `VftNativeExchange` service, which is the only route between them.
 *
 * This is a wrapper, not a trade: no price, no slippage, no counterparty. One VARA
 * is always exactly one wVARA, minus the gas to make the call.
 *
 * ## Install
 *
 *   npm install @gear-js/api@0.45.0 @polkadot/api@12.4.2 @polkadot/util \
 *               @polkadot/wasm-crypto sails-js@0.5.1 sails-js-parser@0.5.1
 *
 * ## Use
 *
 *   VARA_SEED="<twelve word mnemonic>" node vara-wrap.mjs balance
 *   VARA_SEED="..." node vara-wrap.mjs unwrap 5        # 5 wVARA  -> native VARA
 *   VARA_SEED="..." node vara-wrap.mjs unwrap all      # everything
 *   VARA_SEED="..." node vara-wrap.mjs wrap 10         # 10 VARA -> wVARA
 *
 * Amounts are in whole tokens; the 12 decimals are handled here.
 */

import { GearApi } from '@gear-js/api';
import { Keyring } from '@polkadot/api';
import { u8aToHex, u8aConcat, stringToU8a, compactToU8a } from '@polkadot/util';
import { waitReady } from '@polkadot/wasm-crypto';
import { Sails } from 'sails-js';
import { SailsIdlParser } from 'sails-js-parser';

const NODE = process.env.NODE_ADDRESS ?? 'wss://rpc.vara.network';
/** wVARA on Vara mainnet. */
const WVARA = '0x29c42c668012b1ce20720e4615229215023281ef4676fdc77bf047d7fbcb9d17';
const DECIMALS = 12n;
const ONE = 10n ** DECIMALS;
/** Left unwrapped so the account can still pay for its next transaction. */
const GAS_RESERVE = 2n * ONE;

const [action, rawAmount] = process.argv.slice(2);
const SEED = process.env.VARA_SEED;

function die(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

if (!SEED) die('VARA_SEED is not set. Pass the seed phrase of the wallet holding the tokens.');
if (!['balance', 'wrap', 'unwrap'].includes(action)) {
  die('Usage: node vara-wrap.mjs <balance|wrap|unwrap> [amount|all]');
}

/** Whole tokens to smallest-units, exactly (no float rounding). */
function toUnits(text) {
  if (!/^\d*\.?\d*$/.test(text) || text === '' || text === '.') {
    die(`"${text}" is not a number. Use e.g. 5 or 5.25`);
  }
  const [whole = '0', frac = ''] = text.split('.');
  return BigInt(whole || '0') * ONE + BigInt(frac.padEnd(Number(DECIMALS), '0').slice(0, Number(DECIMALS)) || '0');
}

const show = (units) => (Number(units) / Number(ONE)).toLocaleString(undefined, { maximumFractionDigits: 6 });

await waitReady();
const api = await GearApi.create({ providerAddress: NODE });
const account = new Keyring({ type: 'sr25519' }).addFromUri(SEED.trim());
const accountId = u8aToHex(account.addressRaw);

// Minimal IDL: just enough to read the wVARA balance. The writes go through raw
// routes below, so nothing here has to match the full token interface.
const parser = await SailsIdlParser.new();
const vft = new Sails(parser);
vft.parseIdl('service Vft { query BalanceOf : (account: actor_id) -> u256; };');
vft.setProgramId(WVARA);
vft.setApi(api);

const nativeBalance = async () =>
  BigInt((await api.query.system.account(account.address)).data.free.toString());
const wrappedBalance = async () =>
  BigInt((await vft.services.Vft.queries.BalanceOf(accountId).call()).toString());

/**
 * Send a raw Sails route to the wVARA program.
 *
 * The payload is SCALE: string service, string method, then the arguments. Built by
 * hand because the wrapper service is not in the standard VFT interface.
 */
async function call(service, method, argBytes = new Uint8Array(), value = 0n) {
  const str = (s) => {
    const bytes = stringToU8a(s);
    return u8aConcat(compactToU8a(bytes.length), bytes);
  };
  const payload = u8aToHex(u8aConcat(str(service), str(method), argBytes));
  const gas = await api.program.calculateGas.handle(accountId, WVARA, payload, value, true);
  const gasLimit = (gas.min_limit.toBigInt() * 5n) / 2n;
  const tx = api.message.send({ destination: WVARA, payload, gasLimit, value });
  await new Promise((resolve, reject) => {
    tx.signAndSend(account, { nonce: -1 }, ({ status, dispatchError, events }) => {
      if (dispatchError) {
        let detail = dispatchError.toString();
        if (dispatchError.isModule) {
          try {
            const d = api.registry.findMetaError(dispatchError.asModule);
            detail = `${d.section}.${d.name}: ${(d.docs || []).join(' ')}`;
          } catch { /* keep the raw form */ }
        }
        return reject(new Error(detail));
      }
      if (status.isInBlock || status.isFinalized) {
        const failed = events.find(({ event }) => api.events.system.ExtrinsicFailed.is(event));
        return failed ? reject(new Error('extrinsic failed')) : resolve();
      }
    }).catch(reject);
  });
}

console.log(`\n  account: ${account.address}`);
console.log(`  node:    ${NODE}`);

const native0 = await nativeBalance();
const wrapped0 = await wrappedBalance();
console.log(`\n  native VARA : ${show(native0)}`);
console.log(`  wVARA       : ${show(wrapped0)}\n`);

if (action === 'balance') {
  await api.disconnect();
  process.exit(0);
}

let amount;
if (action === 'unwrap') {
  amount = rawAmount === 'all' ? wrapped0 : toUnits(rawAmount ?? '');
  if (amount <= 0n) die('Nothing to unwrap.');
  if (amount > wrapped0) die(`Only ${show(wrapped0)} wVARA available.`);
  if (native0 < ONE / 2n) die('Not enough native VARA left to pay for the transaction.');
} else {
  // Wrapping spends native VARA, which also pays the gas, so keep a reserve back.
  const spendable = native0 > GAS_RESERVE ? native0 - GAS_RESERVE : 0n;
  amount = rawAmount === 'all' ? spendable : toUnits(rawAmount ?? '');
  if (amount <= 0n) die('Nothing to wrap.');
  if (amount > spendable) {
    die(`Only ${show(spendable)} VARA can be wrapped (${show(GAS_RESERVE)} is held back for gas).`);
  }
}

process.stdout.write(`  ${action === 'wrap' ? 'wrapping' : 'unwrapping'} ${show(amount)} … `);
try {
  if (action === 'wrap') {
    // Mint is payable: the attached value is what gets wrapped.
    await call('VftNativeExchange', 'Mint', new Uint8Array(), amount);
  } else {
    // Burn takes U256, matching the VFT balance type. Encoding it as u128 gives a
    // 16-byte argument the router cannot match, and the program then reports an
    // unknown route rather than a bad argument.
    await call('VftNativeExchange', 'Burn', api.createType('U256', amount).toU8a());
  }
  console.log('done');
} catch (e) {
  console.log('failed');
  die(String(e?.message ?? e));
}

console.log(`\n  native VARA : ${show(await nativeBalance())}`);
console.log(`  wVARA       : ${show(await wrappedBalance())}\n`);

await api.disconnect();
process.exit(0);
