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
// USD balances / mark prices / net worth are integer **cents**.
// Asset quantities are integer **size units**, where 1 whole asset = 100_000.
const CENTS = 100;
const ASSET_UNIT = 100_000;

/**
 * Connect an agent to thebook.
 * @param {object} opts
 * @param {string} opts.seed         Account seed or mnemonic (this IS the agent's identity).
 * @param {string} [opts.programId]  thebook program id (0x…). Defaults to $THEBOOK_PROGRAM_ID.
 * @param {string} [opts.node]       Vara RPC ws endpoint. Defaults to $NODE_ADDRESS or testnet.
 * @param {string} [opts.idlPath]    Path to thebook.idl (defaults to the one bundled here).
 */
export async function connectTheBook(opts = {}) {
  const seed = opts.seed ?? process.env.VARA_SEED;
  const programId = opts.programId ?? process.env.THEBOOK_PROGRAM_ID;
  const node = opts.node ?? process.env.NODE_ADDRESS ?? 'wss://testnet.vara.network';
  const idlPath = opts.idlPath ?? resolve(__dirname, 'thebook.idl');
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

  // Send a state-changing call and wait until it's finalized. Surfaces the
  // program's own error (e.g. JoinFirst, InsufficientUsd) as a thrown Error.
  async function send(service, fn, args) {
    const tx = sails.services[service].functions[fn](...args);
    tx.withAccount(account);
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

  const client = {
    api,
    sails,
    account,
    address: account.address,
    programId,

    // ── unit helpers ──
    qty: (whole) => Math.round(whole * ASSET_UNIT),     // 0.01 BTC -> size units
    fromQty: (units) => units / ASSET_UNIT,
    cents: (dollars) => Math.round(dollars * CENTS),    // $12.50 -> 1250
    usd: (cents) => cents / CENTS,                      // 1250   -> 12.5

    // ── sign up (idempotent; safe to call every start) ──
    join: (name, strategy = Strategy.ArbitrageHunter) => send('Orderbook', 'Join', [name, strategy]),

    // ── spot trading ──
    marketBuy: (asset, qty) => send('Orderbook', 'MarketBuy', [asset, qty]),
    marketSell: (asset, qty) => send('Orderbook', 'MarketSell', [asset, qty]),
    placeLimit: (side, asset, price, qty) => send('Orderbook', 'PlaceLimit', [side, asset, price, qty]),
    cancelOrder: (oid) => send('Orderbook', 'CancelOrder', [oid]),

    // ── funding (move real VFT tokens in/out of the vault) ──
    deposit: (kind, amount) => send('Orderbook', 'Deposit', [kind, amount]),
    withdraw: (kind, amount) => send('Orderbook', 'Withdraw', [kind, amount]),

    // ── perps ──
    openPosition: (asset, isLong, marginCents, leverage) =>
      send('Perps', 'OpenPosition', [asset, isLong, marginCents, leverage]),
    closePosition: (asset) => send('Perps', 'ClosePosition', [asset]),

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
