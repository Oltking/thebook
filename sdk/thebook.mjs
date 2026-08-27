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
  let voucherId = null;
  let voucherTried = false;
  async function ensureVoucher() {
    if (!voucherEndpoint || voucherTried) return voucherId;
    voucherTried = true;
    try {
      const res = await fetch(voucherEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: account.address }),
      });
      if (res.ok) {
        const d = await res.json();
        if (d && d.enabled && d.voucherId) voucherId = d.voucherId;
      }
    } catch { /* no backend / offline — self-paid gas */ }
    return voucherId;
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
    await tx.calculateGas(true);
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
    await tx.calculateGas(true);
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
      // id). Required once before that token can back an order; approve a large amount
      // to avoid re-approving every trade (standing-allowance tradeoff).
      approve: (token, amount) => sendVft(token, 'Approve', [programId, amount]),
      // The wallet's real balance / current DEX allowance for a token (smallest-units).
      balanceOf: (token) => queryVft(token, 'BalanceOf', [account.address]),
      allowance: (token) => queryVft(token, 'Allowance', [account.address, programId]),
      // Admin/multisig only.
      listPair: (base, quote, baseDec, quoteDec) =>
        send('Spot', 'ListPair', [base, quote, baseDec, quoteDec]),
      delistPair: (pairId) => send('Spot', 'DelistPair', [pairId]),
      transferAdmin: (newAdmin) => send('Spot', 'TransferAdmin', [newAdmin]),
      // Trading.
      placeLimit: (pairId, side, price, qty) =>
        send('Spot', 'PlaceLimit', [pairId, side, price, qty]),
      marketBuy: (pairId, qty, maxQuote) => send('Spot', 'MarketBuy', [pairId, qty, maxQuote]),
      marketSell: (pairId, qty) => send('Spot', 'MarketSell', [pairId, qty]),
      cancelOrder: (oid) => send('Spot', 'CancelOrder', [oid]),
      // Pull filled proceeds / cancelled escrow of `token` back to your wallet.
      withdraw: (token) => send('Spot', 'Withdraw', [token]),
      // Reads.
      pairs: () => query('Spot', 'GetPairs'),
      pair: (pairId) => query('Spot', 'GetPair', [pairId]),
      async orderbook(pairId) {
        const [bids, asks] = await query('Spot', 'GetOrderbook', [pairId]);
        const lvl = ([p, q]) => ({ price: BigInt(p), qty: BigInt(q) });
        return { bids: bids.map(lvl), asks: asks.map(lvl) };
      },
      myOrders: () => query('Spot', 'GetMyOrders'),
      claim: (token) => query('Spot', 'GetClaim', [token]),
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
      addMarket: (symbol) => send('PerpsV1', 'AddMarket', [symbol]),
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
      positions: (owner) => query('PerpsV1', 'GetPositions', [owner ?? account.address]),
      liqPrice: (positionId) => query('PerpsV1', 'GetLiqPrice', [positionId]),
    },

    disconnect: () => api.disconnect(),
  };

  return client;
}
