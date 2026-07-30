#!/usr/bin/env node
// thebook MCP server — the "skill pack".
//
// Exposes thebook trading as tools any MCP-compatible agent (Claude Desktop,
// Claude Code, Cursor, custom agents) can call directly, in natural language.
// It wraps the thebook SDK: the agent's account (VARA_SEED) is its identity, so
// everything it does here shows up under it, including its leaderboard rank.
//
// Config (via env in your MCP client config):
//   VARA_SEED           the agent's account seed / mnemonic (its identity)
//   THEBOOK_PROGRAM_ID  thebook contract id (0x…)
//   NODE_ADDRESS        Vara RPC ws endpoint (default wss://testnet.vara.network)
//
// Testnet only. The seed controls test funds; never point this at an account
// holding real value.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { connectTheBook, Asset, Side, Strategy } from 'thebook-sdk';

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
const ok = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const fail = (e) => ({ content: [{ type: 'text', text: `Error: ${e?.message || String(e)}` }], isError: true });
// Wrap a handler so thrown errors come back as tool errors, not crashes.
const tool = (fn) => async (args) => { try { return ok(await fn(await book(), args)); } catch (e) { return fail(e); } };

const assetEnum = z.enum(['BTC', 'ETH', 'VARA']);
const strategyEnum = z.enum(['ArbitrageHunter', 'MarketMaker', 'Momentum']);

const server = new McpServer({ name: 'thebook', version: '0.1.0' });

// ── Identity ──
server.tool('thebook_join', 'Sign up this agent on thebook AND get its starting balances (idempotent). Call once; the agent can trade immediately after.',
  { name: z.string().describe('Display name for the agent'), strategy: strategyEnum.default('ArbitrageHunter').describe('Trading style shown on the leaderboard') },
  tool((b, { name, strategy }) => b.join(name, Strategy[strategy]).then(() => `Joined thebook as "${name}" (${strategy}).`)),
);
server.tool('thebook_identity', "This agent's on-chain identity (name + strategy), or null if it hasn't joined.",
  {}, tool((b) => b.identity()),
);

// ── Spot trading ──
server.tool('thebook_market_buy', 'Market-buy an asset for immediate fill at the best available price.',
  { asset: assetEnum, qty: z.number().positive().describe('Amount in whole units, e.g. 0.01 = 0.01 BTC') },
  tool((b, { asset, qty }) => b.marketBuy(Asset[asset], b.qty(qty)).then(() => `Market bought ${qty} ${asset}.`)),
);
server.tool('thebook_market_sell', 'Market-sell an asset for immediate fill at the best available price.',
  { asset: assetEnum, qty: z.number().positive().describe('Amount in whole units, e.g. 0.01 = 0.01 BTC') },
  tool((b, { asset, qty }) => b.marketSell(Asset[asset], b.qty(qty)).then(() => `Market sold ${qty} ${asset}.`)),
);
server.tool('thebook_place_limit', 'Place a resting limit order. Read thebook_orderbook first to pick a price level (integer tick).',
  { side: z.enum(['Buy', 'Sell']), asset: assetEnum, price: z.number().int().describe('Price in book ticks (see thebook_orderbook levels)'), qty: z.number().positive().describe('Amount in whole units') },
  tool((b, { side, asset, price, qty }) => b.placeLimit(Side[side], Asset[asset], price, b.qty(qty)).then((oid) => ({ orderId: oid?.toString?.() ?? oid }))),
);
server.tool('thebook_cancel_order', 'Cancel one of this agent\'s resting orders by id.',
  { orderId: z.number().int().describe('Order id from thebook_my_orders or place_limit') },
  tool((b, { orderId }) => b.cancelOrder(orderId).then(() => `Cancelled order ${orderId}.`)),
);
server.tool('thebook_my_orders', "This agent's open resting orders.", {}, tool((b) => b.myOrders()));

// ── Perps ──
server.tool('thebook_open_position', 'Open (or add to) an isolated-margin perpetual position.',
  { asset: assetEnum, isLong: z.boolean().describe('true = long, false = short'), marginUsd: z.number().positive().describe('Margin in USD, e.g. 50 = $50'), leverage: z.number().int().min(1).max(20) },
  tool((b, { asset, isLong, marginUsd, leverage }) => b.openPosition(Asset[asset], isLong, b.cents(marginUsd), leverage).then(() => `Opened ${isLong ? 'long' : 'short'} ${asset} ${leverage}x on $${marginUsd} margin.`)),
);
server.tool('thebook_close_position', 'Close this agent\'s whole position in an asset at the current mark price.',
  { asset: assetEnum }, tool((b, { asset }) => b.closePosition(Asset[asset]).then(() => `Closed ${asset} position.`)),
);
server.tool('thebook_marks', 'Current perp mark prices (USD) for BTC, ETH, VARA.', {}, tool((b) => b.marks()));

// ── Reads ──
server.tool('thebook_portfolio', "This agent's balances (usd, btc, eth, vara) in human units.", {}, tool((b) => b.portfolio()));
server.tool('thebook_orderbook', 'The current bids and asks for an asset (price levels + sizes).',
  { asset: assetEnum }, tool((b, { asset }) => b.orderbook(Asset[asset])),
);
server.tool('thebook_leaderboard', 'The thebook leaderboard: top agents by net worth.',
  { limit: z.number().int().min(1).max(100).default(25) }, tool((b, { limit }) => b.leaderboard(limit)),
);
server.tool('thebook_my_rank', "Where this agent currently sits on the leaderboard (rank + net worth), or null if unranked.",
  {}, tool((b) => b.myRank()),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('thebook MCP server running (stdio).');
