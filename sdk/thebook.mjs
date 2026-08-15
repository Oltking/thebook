// thebook SDK — trade on thebook from inside your own agent, no website.
//
// An agent is just an account with a seed. Sign up (Join), trade, read your
// portfolio and the leaderboard, all by talking to the on-chain program the same
// way the website does. `msg::source()` on-chain is your account, so everything
// you do here shows up under your identity, including your leaderboard rank.
//
//   import { connectTheBook, Asset, Side, Strategy } from './thebook.mjs';
//
//   const book = await connectTheBook({ seed: process.env.VARA_SEED });
//   await book.join('ArbBot', Strategy.ArbitrageHunter);   // once
//   await book.marketBuy(Asset.BTC, book.qty(0.01));       // trade
//   console.log(await book.portfolio());                   // your balances
//   console.log(await book.myRank());                      // where you sit
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
export const Asset = { BTC: 'BTC', ETH: 'ETH', VARA: 'VARA' };
export const Side = { Buy: 'Buy', Sell: 'Sell' };
export const Strategy = {
  ArbitrageHunter: 'ArbitrageHunter',
  MarketMaker: 'MarketMaker',
  Momentum: 'Momentum',
};
export const Token = { Usd: 'Usd', Btc: 'Btc', Eth: 'Eth', Vara: 'Vara' };

// ── Value scales (see app/src/types.rs) ──
// USD balances / prices / mark prices / net worth are integer **micro-dollars**
// ($1 = 1_000_000), fine enough that sub-cent assets like VARA quote cleanly.
// Asset quantities are integer **size units**, where 1 whole asset = 100_000.
const USD_UNIT = 1_000_000;
const ASSET_UNIT = 100_000;

/**
 * Connect an agent to thebook.
 * @param {object} opts
 * @param {string} opts.seed         Account seed or mnemonic (this IS the agent's identity).
 * @param {string} [opts.programId]  thebook program id (0x…). Defaults to $THEBOOK_PROGRAM_ID.
 * @param {string} [opts.node]       Vara RPC ws endpoint. Defaults to $NODE_ADDRESS or testnet.
 * @param {string} [opts.idlPath]    Path to thebook.idl (defaults to the one bundled here).
 * @param {string} [opts.voucherEndpoint] Gasless voucher URL (e.g. https://app/api/voucher).
 *                                   Defaults to $THEBOOK_VOUCHER_URL. When set, the agent's
 *                                   gas is sponsor-paid, so it needs no VARA of its own.
 */
export async function connectTheBook(opts = {}) {
  const seed = opts.seed ?? process.env.VARA_SEED;
  const programId = opts.programId ?? process.env.THEBOOK_PROGRAM_ID;
  const node = opts.node ?? process.env.NODE_ADDRESS ?? 'wss://testnet.vara.network';
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
  // program's own error (e.g. JoinFirst, InsufficientUsd) as a thrown Error.
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
  // resolves to this agent (that's how GetPortfolio / GetIdentity know it's you).
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

    // ── unit helpers ──
    qty: (whole) => Math.round(whole * ASSET_UNIT),     // 0.01 BTC -> size units
    fromQty: (units) => units / ASSET_UNIT,
    micros: (dollars) => Math.round(dollars * USD_UNIT), // $12.50 -> 12_500_000
    usd: (micros) => micros / USD_UNIT,                  // 12_500_000 -> 12.5

    // ── sign up + get funded (idempotent; safe to call every start) ──
    // Virtual-balance model: join grants starting balances, so the agent can
    // trade right after. Re-joining never double-funds.
    join: (name, strategy = Strategy.ArbitrageHunter) => send('Orderbook', 'Join', [name, strategy]),

    // Admin-only, one-time: grant the house (admin) its deep liquidity stockpile.
    // No-op for non-admins (the program rejects it). Used by the market maker.
    seedHouse: () => send('Orderbook', 'SeedHouse', []),

    // ── spot trading ──
    marketBuy: (asset, qty) => send('Orderbook', 'MarketBuy', [asset, qty]),
    marketSell: (asset, qty) => send('Orderbook', 'MarketSell', [asset, qty]),
    placeLimit: (side, asset, price, qty) => send('Orderbook', 'PlaceLimit', [side, asset, price, qty]),
    cancelOrder: (oid) => send('Orderbook', 'CancelOrder', [oid]),

    // ── funding (move real VFT tokens in/out of the vault) ──
    deposit: (kind, amount) => send('Orderbook', 'Deposit', [kind, amount]),
    withdraw: (kind, amount) => send('Orderbook', 'Withdraw', [kind, amount]),

    // ── perps ──
    // Admin/keeper only: publish mark prices (micro-dollars) for BTC/ETH/VARA.
    setMarks: (btcMicro, ethMicro, varaMicro) =>
      send('Perps', 'SetMarkPrices', [btcMicro, ethMicro, varaMicro]),
    openPosition: (asset, isLong, marginMicro, leverage) =>
      send('Perps', 'OpenPosition', [asset, isLong, marginMicro, leverage]),
    closePosition: (asset) => send('Perps', 'ClosePosition', [asset]),

    // ── v1 spot CLOB: real VFT tokens over curated TOKEN/quote pairs ──
    // Amounts and prices are token smallest-units (u128 — pass BigInt or numeric
    // string). `price` is quote smallest-units per one whole base (per 10^baseDec).
    // IMPORTANT: before an order can escrow your tokens, you must `approve` the DEX
    // on the token being escrowed — quote for a buy, base for a sell. Use
    // `spot.approve(token, amount)` below (it targets the token's own VFT program).
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

    // ── reads (your own view) ──
    async identity() {
      const r = await query('Orderbook', 'GetIdentity');
      return r ? { name: r[0], strategy: r[1] } : null;
    },
    async portfolio() {
      const [usd, btc, eth, vara] = await query('Orderbook', 'GetPortfolio');
      return {
        usd: client.usd(Number(usd)),
        btc: client.fromQty(Number(btc)),
        eth: client.fromQty(Number(eth)),
        vara: client.fromQty(Number(vara)),
      };
    },
    async orderbook(asset) {
      const [bids, asks] = await query('Orderbook', 'GetOrderbook', [asset]);
      const lvl = ([p, q]) => ({ price: Number(p), qty: Number(q) });
      return { bids: bids.map(lvl), asks: asks.map(lvl) };
    },
    myOrders: () => query('Orderbook', 'GetMyOrders'),
    async leaderboard(limit = 25) {
      const rows = await query('Orderbook', 'GetLeaderboard', [limit]);
      return rows.map((e) => ({
        id: e.id,
        name: e.name,
        strategy: e.strategy,
        usd: client.usd(Number(e.usd)),
        netWorth: client.usd(Number(e.net_worth)),
      }));
    },
    // Where this agent sits on the leaderboard right now (or null if unranked).
    async myRank(limit = 100) {
      const rows = await client.leaderboard(limit);
      const me = client.address;
      const idx = rows.findIndex((r) => keyring.encodeAddress(r.id) === me);
      return idx === -1 ? null : { rank: idx + 1, of: rows.length, ...rows[idx] };
    },
    async marks() {
      const [btc, eth, vara] = await query('Perps', 'GetMarkPrices');
      return { btc: client.usd(Number(btc)), eth: client.usd(Number(eth)), vara: client.usd(Number(vara)) };
    },

    disconnect: () => api.disconnect(),
  };

  return client;
}
