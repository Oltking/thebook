// thebook SDK — trade thebookdex from inside your own agent, no website.
//
// An agent is just an account with a seed. Sign the same on-chain calls the web
// app does: `msg::source()` on-chain is your account, so every order is yours.
//
// thebookdex v1 is a NON-CUSTODIAL spot CLOB over real bridged VFT tokens on Vara
// mainnet (plus cash-settled perps). You trade by escrowing real tokens per order:
// approve the DEX on the token's own VFT program, place the order, then withdraw
// your filled proceeds / cancelled escrow. There are no virtual balances.
//
//   import { connectTheBook, Side } from './thebook.mjs';
//
//   const book = await connectTheBook({ seed: process.env.VARA_SEED });
//   const [ethUsdt] = await book.spot.pairs();               // curated markets
//   await book.spot.approve(ethUsdt.quote, book.units(100, 6)); // approve 100 wUSDT
//   await book.spot.placeLimit(ethUsdt.id, Side.Buy,
//     book.units(2500, 6), book.units(0.01, 18));            // buy 0.01 ETH @ 2500
//   await book.spot.withdraw(ethUsdt.base);                  // pull filled ETH out
//
// Requires: @gear-js/api @polkadot/api @polkadot/wasm-crypto sails-js sails-js-parser

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { GearApi } from '@gear-js/api';
import { Keyring } from '@polkadot/api';
import { u8aToHex, stringToU8a } from '@polkadot/util';
import { waitReady } from '@polkadot/wasm-crypto';
import { Sails } from 'sails-js';
import { SailsIdlParser } from 'sails-js-parser';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── On-chain enums (order must match the program) ──
export const Side = { Buy: 'Buy', Sell: 'Sell' };

// Convert a human amount to a token's smallest-units (u128), given its decimals.
// String-based so it is exact for 18-decimal tokens (wETH) that overflow floats.
export function toUnits(amount, decimals) {
  const s = String(amount).trim();
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') {
    throw new Error(`toUnits: invalid amount "${amount}"`);
  }
  const [whole = '0', frac = ''] = s.split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fracPadded || '0');
}

// Convert a token's smallest-units back to a human decimal string.
export function fromUnits(raw, decimals) {
  const neg = BigInt(raw) < 0n;
  const v = neg ? -BigInt(raw) : BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

/**
 * Connect an agent to thebookdex.
 * @param {object} opts
 * @param {string} opts.seed         Account seed or mnemonic (this IS the agent's identity).
 * @param {string} [opts.programId]  thebookdex program id (0x…). Defaults to $THEBOOK_PROGRAM_ID.
 * @param {string} [opts.node]       Vara RPC ws endpoint. Defaults to $NODE_ADDRESS or Vara mainnet.
 * @param {string} [opts.idlPath]    Path to thebook.idl (defaults to the one bundled here).
 * @param {string} [opts.voucherEndpoint] Gasless voucher URL (e.g. https://app/api/voucher).
 *                                   Defaults to $THEBOOK_VOUCHER_URL. When set, the agent's
 *                                   gas is sponsor-paid, so it needs no VARA of its own.
 */
export async function connectTheBook(opts = {}) {
  const seed = opts.seed ?? process.env.VARA_SEED;
  const programId = opts.programId ?? process.env.THEBOOK_PROGRAM_ID;
  const node = opts.node ?? process.env.NODE_ADDRESS ?? 'wss://rpc.vara.network';
  const idlPath = opts.idlPath ?? resolve(__dirname, 'thebook.idl');
  // Optional gasless voucher endpoint (the same /api/voucher the web app uses). When
  // set, the agent's transactions are paid by the sponsor account, so the agent
  // needs no VARA of its own. Falls back to self-paid gas if the endpoint is absent
  // or errors. See frontend/api/voucher.ts for the server side.
  const voucherEndpoint = opts.voucherEndpoint ?? process.env.THEBOOK_VOUCHER_URL;
  if (!seed) throw new Error('connectTheBook: a `seed` is required (the agent account).');
  if (!programId) throw new Error('connectTheBook: a `programId` is required (thebook contract).');

  await waitReady();
  const parser = await SailsIdlParser.new();
  const sails = new Sails(parser);
  sails.parseIdl(readFileSync(idlPath, 'utf-8'));
  const api = await GearApi.create({ providerAddress: node });
  sails.setApi(api);
  sails.setProgramId(programId);

  const keyring = new Keyring({ type: 'sr25519' });
  const account = keyring.addFromUri(seed);

  // Gasless: request (once, lazily) a sponsor-funded voucher for this agent from the
  // configured endpoint, and reuse it for every tx. Silent fallback to self-paid gas.
  // A failed attempt is retried on a backoff rather than remembered forever: the
  // old version tried once, cached the failure for the process lifetime and swallowed
  // the error, so an agent that started while the endpoint was briefly down paid its
  // own gas for the rest of its life with no signal (audit L-14).
  let voucherId = null;
  let voucherNextTry = 0;
  let voucherFailures = 0;
  const VOUCHER_RETRY_BASE_MS = 30_000;
  const VOUCHER_RETRY_MAX_MS = 15 * 60_000;
  /** Last voucher error, if any. Readable via `book.voucherStatus()`. */
  let voucherError = null;

  async function ensureVoucher() {
    if (!voucherEndpoint || voucherId) return voucherId;
    if (Date.now() < voucherNextTry) return null;
    try {
      // Two-step challenge: the endpoint issues a nonce, we sign it to prove we hold
      // the key, then redeem it (audit H-01).
      const chRes = await fetch(`${voucherEndpoint}?account=${encodeURIComponent(account.address)}`);
      if (!chRes.ok) throw new Error(`challenge HTTP ${chRes.status}`);
      const ch = await chRes.json();
      if (!ch?.enabled) { voucherError = 'voucher endpoint disabled'; voucherNextTry = Infinity; return null; }
      if (!ch?.nonce) throw new Error('no nonce returned');
      const signature = u8aToHex(account.sign(stringToU8a(ch.nonce)));
      const res = await fetch(voucherEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: account.address, nonce: ch.nonce, signature }),
      });
      if (!res.ok) throw new Error(`redeem HTTP ${res.status}`);
      const d = await res.json();
      if (d && d.enabled && d.voucherId) {
        voucherId = d.voucherId;
        voucherError = null;
        voucherFailures = 0;
      } else {
        throw new Error('no voucher issued');
      }
    } catch (e) {
      voucherError = String(e?.message || e);
      voucherFailures += 1;
      const backoff = Math.min(VOUCHER_RETRY_BASE_MS * 2 ** (voucherFailures - 1), VOUCHER_RETRY_MAX_MS);
      voucherNextTry = Date.now() + backoff;
      if (voucherFailures === 1) {
        console.warn(`thebook: gasless voucher unavailable (${voucherError}); paying own gas, retrying in ${Math.round(backoff / 1000)}s`);
      }
    }
    return voucherId;
  }

  /**
   * Give a transaction a gas limit.
   *
   * Gear's gas-estimation RPC cannot simulate a program that awaits a cross-program
   * reply, and aborts with "Unable to call a forbidden function". Every method here
   * that escrows or moves tokens does exactly that, so estimation is allowed to fail
   * and we fall back to an explicit limit. Unused gas is refunded, so the fallback
   * costs only a temporary reservation. A real program error still propagates.
   */
  async function prepareGas(tx) {
    try {
      await tx.calculateGas(true);
    } catch (e) {
      if (!/forbidden function/i.test(String(e?.message ?? e))) throw e;
      tx.withGas('max');
    }
  }

// Send a state-changing call and wait until it's finalized. Surfaces the
  // program's own error (e.g. UnknownPair, InsufficientAllowance) as a thrown Error.
  async function send(service, fn, args) {
    const tx = sails.services[service].functions[fn](...args);
    // `nonce: -1` makes polkadot resolve the nonce via accountNextIndex, which counts
    // transactions still pending in the pool. Without it, rapid back-to-back sends
    // (e.g. a market maker re-quoting a ladder) reuse the on-chain nonce before the
    // previous tx is in a block and collide with "Priority is too low".
    tx.withAccount(account, { nonce: -1 });
    const vid = await ensureVoucher();
    if (vid) tx.withVoucher(vid);
    await prepareGas(tx);
    const { response } = await tx.signAndSend();
    const value = await response();
    if (value && typeof value === 'object' && 'err' in value) {
      throw new Error(`thebook ${service}.${fn} rejected: ${JSON.stringify(value.err)}`);
    }
    return value && typeof value === 'object' && 'ok' in value ? value.ok : value;
  }

  // Read a query from the account's own perspective, so msg::source() on-chain
  // resolves to this agent (that's how GetMyOrders / GetClaim know it's you).
  function query(service, fn, args = []) {
    return sails.services[service].queries[fn](...args).withAddress(account.address).call();
  }

  // ── VFT token clients (for the spot approve → balance → allowance flow) ──
  // Escrowing a spot order requires approving the DEX on the token's own VFT program.
  // We build a Sails client per token (lazily, cached) from the shared VFT IDL.
  const vftIdlPath = opts.vftIdlPath ?? resolve(__dirname, 'vft.idl');
  const vftIdlText = readFileSync(vftIdlPath, 'utf-8');
  const vftCache = new Map();
  function vftFor(tokenId) {
    let s = vftCache.get(tokenId);
    if (!s) {
      s = new Sails(parser);
      s.parseIdl(vftIdlText);
      s.setApi(api);
      s.setProgramId(tokenId);
      vftCache.set(tokenId, s);
    }
    return s;
  }
  async function sendVft(tokenId, fn, args) {
    const tx = vftFor(tokenId).services.Vft.functions[fn](...args);
    tx.withAccount(account, { nonce: -1 });
    const vid = await ensureVoucher();
    if (vid) tx.withVoucher(vid);
    await prepareGas(tx);
    const { response } = await tx.signAndSend();
    return await response();
  }
  function queryVft(tokenId, fn, args = []) {
    return vftFor(tokenId).services.Vft.queries[fn](...args).withAddress(account.address).call();
  }

  const client = {
    api,
    sails,
    account,
    address: account.address,
    programId,

    // Gasless status: resolves the voucher (if an endpoint is configured) and
    // reports whether this agent's txs are sponsor-paid. Called automatically on
    // the first trade; exposed here so an agent can check/warm it up explicitly.
    async gasless() { return !!(await ensureVoucher()); },
    get voucherId() { return voucherId; },

    // ── unit helpers ── amounts are token smallest-units (u128), sized by the
    // token's own decimals (wVARA 12, wETH 18, wUSDT/wUSDC 6).
    units: (whole, decimals) => toUnits(whole, decimals),   // 0.01, 18 -> 10000000000000000n
    toWhole: (raw, decimals) => fromUnits(raw, decimals),   // 10000000000000000n, 18 -> "0.01"

    // ── v1 spot CLOB: real VFT tokens over curated base/quote pairs ──
    // Amounts and prices are token smallest-units (u128 — pass BigInt or numeric
    // string, e.g. via `units`). `price` is quote smallest-units per one whole base
    // (per 10^baseDec). IMPORTANT: before an order can escrow your tokens you must
    // `approve` the DEX on the token being escrowed — quote for a buy, base for a
    // sell. `approve` targets the token's own VFT program.
    spot: {
      // Approve the DEX to escrow `amount` (smallest-units) of `token` (a VFT program
      // id). Approve PER ORDER, for the amount that order escrows. A standing
      // allowance is only ever as safe as the contract holding it, and for an agent
      // it means a compromised or confused key can spend the whole balance rather
      // than one order's worth (audit H-07, M-11).
      approve: (token, amount) => sendVft(token, 'Approve', [programId, amount]),
      // The wallet's real balance / current DEX allowance for a token (smallest-units).
      balanceOf: (token) => queryVft(token, 'BalanceOf', [account.address]),
      allowance: (token) => queryVft(token, 'Allowance', [account.address, programId]),
      // Admin/multisig only. `listPair` verifies the decimals you pass against each
      // token's own metadata and rejects a mismatch.
      listPair: (base, quote, baseDec, quoteDec) =>
        send('Spot', 'ListPair', [base, quote, baseDec, quoteDec]),
      delistPair: (pairId) => send('Spot', 'DelistPair', [pairId]),
      relistPair: (pairId) => send('Spot', 'RelistPair', [pairId]),
      setPaused: (paused) => send('Spot', 'SetPaused', [paused]),
      sweepDust: (token) => send('Spot', 'SweepDust', [token]),
      // Admin handover is two-step: propose, then accept from the new account.
      proposeAdmin: (newAdmin) => send('Spot', 'ProposeAdmin', [newAdmin]),
      acceptAdmin: () => send('Spot', 'AcceptAdmin', []),
      // Trading.
      placeLimit: (pairId, side, price, qty) =>
        send('Spot', 'PlaceLimit', [pairId, side, price, qty]),
      // Market orders REQUIRE a slippage bound: the worst fill you will accept.
      // The order reverts and returns your escrow if the book cannot meet it.
      marketBuy: (pairId, qty, maxQuote, minBaseOut) =>
        send('Spot', 'MarketBuy', [pairId, qty, maxQuote, minBaseOut]),
      marketSell: (pairId, qty, minQuoteOut) =>
        send('Spot', 'MarketSell', [pairId, qty, minQuoteOut]),
      cancelOrder: (oid) => send('Spot', 'CancelOrder', [oid]),
      // Pull proceeds / cancelled escrow back to your wallet. Omit `amount` for all.
      withdraw: (token, amount = null) => send('Spot', 'Withdraw', [token, amount]),
      // Reads. Collections are paginated; the defaults cover a normal book.
      pairs: (offset = 0, limit = 200) => query('Spot', 'GetPairs', [offset, limit]),
      pair: (pairId) => query('Spot', 'GetPair', [pairId]),
      pairCount: () => query('Spot', 'PairCount'),
      async orderbook(pairId, depth = 50) {
        const [bids, asks] = await query('Spot', 'GetOrderbook', [pairId, depth]);
        const lvl = ([p, q]) => ({ price: BigInt(p), qty: BigInt(q) });
        return { bids: bids.map(lvl), asks: asks.map(lvl) };
      },
      myOrders: (offset = 0, limit = 200) => query('Spot', 'GetMyOrders', [offset, limit]),
      claim: (token) => query('Spot', 'GetClaim', [token]),
      isPaused: () => query('Spot', 'IsPaused'),
      /** `{ escrow, dust, reserve }` held for a token — the solvency invariant's
       *  right-hand side, for monitoring. */
      async solvency(token) {
        const [escrow, dust, reserve] = await query('Spot', 'GetSolvency', [token]);
        return { escrow: BigInt(escrow), dust: BigInt(dust), reserve: BigInt(reserve) };
      },
    },

    // ── v1 perps: cash-settled, real wUSDT collateral, settles to spot claims ──
    // Margin/amounts are collateral smallest-units (u128). `price` (mark) is any
    // consistent unit (PnL uses price ratios). Margin escrow needs a prior
    // `spot.approve(collateralToken, amount)`; payouts withdraw via `spot.withdraw`.
    // NOTE: perps are built but not yet enabled on mainnet (no live mark keeper).
    perps: {
      // Admin/multisig.
      setCollateral: (token) => send('PerpsV1', 'SetCollateral', [token]),
      setKeeper: (who) => send('PerpsV1', 'SetKeeper', [who]),
      // `maxOi` is required: there is no unlimited default.
      addMarket: (symbol, maxOi) => send('PerpsV1', 'AddMarket', [symbol, maxOi]),
      setMarketCap: (marketId, maxOi) => send('PerpsV1', 'SetMarketCap', [marketId, maxOi]),
      fundReserve: (amount) => send('PerpsV1', 'FundReserve', [amount]),
      withdrawReserve: (amount) => send('PerpsV1', 'WithdrawReserve', [amount]),
      // Keeper: publish a market's mark price.
      setMark: (marketId, price) => send('PerpsV1', 'SetMark', [marketId, price]),
      // Trading.
      open: (marketId, isLong, margin, leverage) =>
        send('PerpsV1', 'OpenPosition', [marketId, isLong, margin, leverage]),
      close: (positionId) => send('PerpsV1', 'ClosePosition', [positionId]),
      liquidate: (positionId) => send('PerpsV1', 'Liquidate', [positionId]),
      // Reads.
      markets: () => query('PerpsV1', 'GetMarkets'),
      reserve: () => query('PerpsV1', 'GetReserve'),
      positions: (owner, offset = 0, limit = 200) =>
        query('PerpsV1', 'GetPositions', [owner ?? account.address, offset, limit]),
      /** `{ reserve, liability, coverageBps }` — check before opening a position. */
      async reserveHealth() {
        const [reserve, liability, coverageBps] = await query('PerpsV1', 'GetReserveHealth');
        return { reserve: BigInt(reserve), liability: BigInt(liability), coverageBps: BigInt(coverageBps) };
      },
      liqPrice: (positionId) => query('PerpsV1', 'GetLiqPrice', [positionId]),
    },

    /** Whether the gasless voucher is active, and why not if it isn't. */
    voucherStatus: () => ({ voucherId, error: voucherError, retryAt: voucherNextTry }),

    disconnect: () => api.disconnect(),
  };

  return client;
}
