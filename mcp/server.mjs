#!/usr/bin/env node
// thebook MCP server — the "skill pack".
//
// Exposes thebook trading as tools any MCP-compatible agent (Claude Desktop,
// Claude Code, Cursor, custom agents) can call directly, in natural language.
// It wraps the thebook SDK: the agent's account (VARA_SEED) is its identity, so
// every order it places is its own. v1 is a non-custodial spot CLOB over real
// bridged tokens — the agent trades the wUSDT/wUSDC/wETH/wVARA in its wallet.
//
// Config (via env in your MCP client config):
//   VARA_SEED           the agent's account seed / mnemonic (its identity)
//   THEBOOK_PROGRAM_ID  thebook contract id (0x…)
//   NODE_ADDRESS        Vara RPC ws endpoint (default wss://rpc.vara.network — mainnet)
//
// MAINNET / real value. The seed controls a wallet holding real tokens — keep it under
// spend limits and only fund it with what the agent may trade.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { connectTheBook } from 'thebook-sdk';

// Connect lazily and once: the first tool call opens the chain connection so the
// server starts instantly even if the node is momentarily unreachable.
let _book = null;
async function book() {
  if (_book) return _book;
  if (!process.env.VARA_SEED) throw new Error('VARA_SEED is not set (the agent account seed).');
  if (!process.env.THEBOOK_PROGRAM_ID) throw new Error('THEBOOK_PROGRAM_ID is not set (thebook contract id).');
  _book = await connectTheBook({
    seed: process.env.VARA_SEED,
    programId: process.env.THEBOOK_PROGRAM_ID,
    node: process.env.NODE_ADDRESS,
  });
  return _book;
}

// Format any result as MCP text content, stringifying objects readably.
const bigintReplacer = (_k, val) => (typeof val === 'bigint' ? val.toString() : val);
const ok = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, bigintReplacer, 2) }] });
const fail = (e) => ({ content: [{ type: 'text', text: `Error: ${e?.message || String(e)}` }], isError: true });
// Wrap a handler so thrown errors come back as tool errors, not crashes.
const tool = (fn) => async (args) => { try { return ok(await fn(await book(), args)); } catch (e) { return fail(e); } };

// Amounts/prices are token smallest-units (u128) — pass as decimal strings so 18-decimal
// tokens don't overflow JS numbers. Pair/order ids are small integers.
const bnStr = z.string().regex(/^\d+$/, 'a whole number as a string (smallest-units)');

const server = new McpServer({ name: 'thebook', version: '0.1.0' });

// ── Markets ──
server.tool('thebook_pairs', 'List the curated spot markets (pair id, base/quote token ids, decimals). Read this first to get a pairId.',
  {}, tool((b) => b.spot.pairs()),
);
server.tool('thebook_orderbook', 'The current bids and asks for a market (price levels + sizes).',
  { pairId: z.number().int().describe('Pair id from thebook_pairs') },
  tool((b, { pairId }) => b.spot.orderbook(BigInt(pairId))),
);

// ── Approvals (required before an order can escrow a token) ──
server.tool('thebook_approve', 'Approve the exchange to escrow a token before trading it (quote token for a buy, base token for a sell). Amount is smallest-units.',
  { token: z.string().describe('Token VFT program id (0x…) from thebook_pairs'), amount: bnStr.describe('Smallest-units to approve; use a large value to avoid re-approving') },
  tool((b, { token, amount }) => b.spot.approve(token, BigInt(amount)).then(() => `Approved ${amount} of ${token}.`)),
);
server.tool('thebook_allowance', "This wallet's current allowance to the exchange for a token, and its balance.",
  { token: z.string().describe('Token VFT program id (0x…)') },
  tool(async (b, { token }) => ({ allowance: (await b.spot.allowance(token)).toString(), balance: (await b.spot.balanceOf(token)).toString() })),
);

// ── Spot trading ──
server.tool('thebook_place_limit', 'Place a resting limit order. Approve the escrow token first (quote for Buy, base for Sell).',
  { pairId: z.number().int(), side: z.enum(['Buy', 'Sell']), price: bnStr.describe('Quote smallest-units per whole base'), qty: bnStr.describe('Base smallest-units') },
  tool((b, { pairId, side, price, qty }) => b.spot.placeLimit(BigInt(pairId), side, BigInt(price), BigInt(qty)).then((oid) => ({ orderId: oid?.toString?.() ?? oid }))),
);
server.tool('thebook_market_buy', 'Market-buy base tokens, spending at most maxQuote. Approve the quote token for maxQuote first.',
  { pairId: z.number().int(), qty: bnStr.describe('Base smallest-units to buy'), maxQuote: bnStr.describe('Max quote smallest-units to spend') },
  tool((b, { pairId, qty, maxQuote }) => b.spot.marketBuy(BigInt(pairId), BigInt(qty), BigInt(maxQuote)).then((oid) => ({ orderId: oid?.toString?.() ?? oid }))),
);
server.tool('thebook_market_sell', 'Market-sell base tokens into the bids. Approve the base token for qty first.',
  { pairId: z.number().int(), qty: bnStr.describe('Base smallest-units to sell') },
  tool((b, { pairId, qty }) => b.spot.marketSell(BigInt(pairId), BigInt(qty)).then((oid) => ({ orderId: oid?.toString?.() ?? oid }))),
);
server.tool('thebook_cancel_order', "Cancel one of this wallet's resting orders by id (refunds unfilled escrow to your claimable balance).",
  { orderId: z.number().int() },
  tool((b, { orderId }) => b.spot.cancelOrder(BigInt(orderId)).then(() => `Cancelled order ${orderId}.`)),
);
server.tool('thebook_my_orders', "This wallet's open and recent orders.", {}, tool((b) => b.spot.myOrders()));

// ── Settlement ──
server.tool('thebook_claim', 'Your withdrawable balance (fills + cancelled escrow) for a token, in smallest-units.',
  { token: z.string().describe('Token VFT program id (0x…)') },
  tool(async (b, { token }) => ({ claim: (await b.spot.claim(token)).toString() })),
);
server.tool('thebook_withdraw', 'Withdraw your full claimable balance of a token back to your wallet.',
  { token: z.string().describe('Token VFT program id (0x…)') },
  tool((b, { token }) => b.spot.withdraw(token).then((amt) => `Withdrew ${amt?.toString?.() ?? amt} of ${token}.`)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('thebook MCP server running (stdio).');
