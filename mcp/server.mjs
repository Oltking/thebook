#!/usr/bin/env node
// thebook MCP server — the "skill pack".
//
// Exposes thebook trading as tools any MCP-compatible agent (Claude Desktop,
// Claude Code, Cursor, custom agents) can call directly, in natural language.
// It wraps the thebook SDK: the agent's account (VARA_SEED) is its identity, so
// every order it places is its own. v1 is a non-custodial spot CLOB over real
// bridged tokens — the agent trades the wUSDT/wUSDC/wETH/wVARA in its wallet.
//
// ## Spend limits
//
// MAINNET, real value. The seed controls a wallet holding real tokens, and the
// contract has no on-chain per-session spend limit yet — so the caps live here
// (audit M-11). Every value-moving tool is bounded by:
//
//   THEBOOK_MAX_TRADE_USD   most one order may commit          (default 100)
//   THEBOOK_MAX_DAILY_USD   most all orders may commit per day (default 500)
//   THEBOOK_CONFIRM_USD     above this, a tool requires confirm:true (default 25)
//
// Caps are enforced in the escrow token's own units against a per-token USD price
// hint, and every tool echoes the human-readable amount before acting — the decimal
// spread across these tokens (wETH 18, wVARA 12, stablecoins 6) makes a single wrong
// exponent a millionfold error, and a model reaching for the wrong one should hit a
// cap rather than the chain.
//
// Set THEBOOK_MAX_TRADE_USD=0 to disable the caps entirely. That is a deliberate
// choice for a funded, supervised agent, not a default.
//
// Config (via env in your MCP client config):
//   VARA_SEED           the agent's account seed / mnemonic (its identity)
//   THEBOOK_PROGRAM_ID  thebook contract id (0x…)
//   NODE_ADDRESS        Vara RPC ws endpoint (default wss://rpc.vara.network — mainnet)

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

/* ── Spend limits (audit M-11) ─────────────────────────────────────────────────── */

const MAX_TRADE_USD = Number(process.env.THEBOOK_MAX_TRADE_USD ?? '100');
const MAX_DAILY_USD = Number(process.env.THEBOOK_MAX_DAILY_USD ?? '500');
const CONFIRM_USD = Number(process.env.THEBOOK_CONFIRM_USD ?? '25');
const LIMITS_ON = MAX_TRADE_USD > 0;

// Decimals and a rough USD value per whole token, by mainnet program id. The USD
// figures only need to be the right order of magnitude: their job is to catch an
// exponent mistake, not to price a trade.
const TOKENS = {
  '0x29c42c668012b1ce20720e4615229215023281ef4676fdc77bf047d7fbcb9d17': { symbol: 'wVARA', decimals: 12, usd: 0.0005 },
  '0xde45bdbb0345919a11561d43a5082e0b25061d4a2c6eb80009c1cfbccb80d0de': { symbol: 'wETH', decimals: 18, usd: 2500 },
  '0x4255ff4a87a4c13dc39f74ace8c4948bbef2f75fb639d66639a1cfcc99e6243e': { symbol: 'wUSDT', decimals: 6, usd: 1 },
  '0xd1de816d7dce6439504552686ab333e5b7302b1549763656b30af1f8a5871b6a': { symbol: 'wUSDC', decimals: 6, usd: 1 },
};

function tokenInfo(id) {
  return TOKENS[String(id || '').toLowerCase()] ?? null;
}

/** Human-readable amount, e.g. "12.5 wUSDT (~$12.50)". */
function describe(tokenId, raw) {
  const t = tokenInfo(tokenId);
  if (!t) return `${raw} smallest-units of ${tokenId} (unknown token — value not checked)`;
  const whole = Number(raw) / 10 ** t.decimals;
  const usd = whole * t.usd;
  return `${whole.toLocaleString(undefined, { maximumFractionDigits: 8 })} ${t.symbol} (~$${usd.toFixed(2)})`;
}

function usdValue(tokenId, raw) {
  const t = tokenInfo(tokenId);
  if (!t) return null; // unknown token: cannot price it, so it cannot be capped
  return (Number(raw) / 10 ** t.decimals) * t.usd;
}

// Rolling 24h spend, in the server process. Restarting the server resets it, which
// is why the per-trade cap matters independently of the daily one.
let spentToday = 0;
let spendWindowStart = Date.now();
function rollWindow() {
  if (Date.now() - spendWindowStart > 24 * 60 * 60 * 1000) {
    spentToday = 0;
    spendWindowStart = Date.now();
  }
}

/**
 * Gate a value-moving action. Throws with an explanation the model can act on,
 * rather than silently proceeding.
 */
function checkSpend({ tokenId, raw, confirm, what }) {
  const human = describe(tokenId, raw);
  if (!LIMITS_ON) return human;
  const usd = usdValue(tokenId, raw);
  if (usd === null) {
    throw new Error(
      `${what}: ${tokenId} is not a known thebook token, so its value cannot be checked ` +
      `against the spend limits. Refusing. Use thebook_pairs to get a listed token id.`,
    );
  }
  rollWindow();
  if (usd > MAX_TRADE_USD) {
    throw new Error(
      `${what} would commit ${human}, over the per-trade limit of $${MAX_TRADE_USD}. ` +
      `Refusing. Check the decimals — wETH is 18, wVARA is 12, wUSDT/wUSDC are 6 — ` +
      `or raise THEBOOK_MAX_TRADE_USD if this is intended.`,
    );
  }
  if (spentToday + usd > MAX_DAILY_USD) {
    throw new Error(
      `${what} would commit ${human}, taking today's total over the daily limit of ` +
      `$${MAX_DAILY_USD} (already ~$${spentToday.toFixed(2)}). Refusing.`,
    );
  }
  if (usd > CONFIRM_USD && !confirm) {
    throw new Error(
      `${what} would commit ${human}. That is above the $${CONFIRM_USD} confirmation ` +
      `threshold. Show the user this amount, and call again with confirm: true only if ` +
      `they agree.`,
    );
  }
  spentToday += usd;
  return human;
}

/** Zod field for the confirmation flag, shared by the value-moving tools. */
const confirmField = z
  .boolean()
  .optional()
  .describe(`Set true only after showing the user the amount, for actions over $${CONFIRM_USD}`);

const server = new McpServer({ name: 'thebook', version: '0.2.0' });

// ── Markets ──
server.tool('thebook_pairs', 'List the curated spot markets (pair id, base/quote token ids, decimals). Read this first to get a pairId.',
  {}, tool((b) => b.spot.pairs()),
);
server.tool('thebook_orderbook', 'The current bids and asks for a market (price levels + sizes).',
  { pairId: z.number().int().describe('Pair id from thebook_pairs') },
  tool((b, { pairId }) => b.spot.orderbook(BigInt(pairId))),
);
server.tool('thebook_limits', 'The spend limits this server enforces, and how much of the daily budget is left. Check before planning a series of trades.',
  {},
  tool(async () => {
    rollWindow();
    return LIMITS_ON
      ? {
          perTradeUsd: MAX_TRADE_USD,
          dailyUsd: MAX_DAILY_USD,
          confirmAboveUsd: CONFIRM_USD,
          spentTodayUsd: Number(spentToday.toFixed(2)),
          remainingTodayUsd: Number((MAX_DAILY_USD - spentToday).toFixed(2)),
        }
      : { limits: 'disabled (THEBOOK_MAX_TRADE_USD=0)' };
  }),
);

// ── Approvals (required before an order can escrow a token) ──
server.tool('thebook_approve', 'Approve the exchange to escrow a token before trading it (quote token for a buy, base token for a sell). Approve exactly what the next order needs — not a large standing amount.',
  {
    token: z.string().describe('Token VFT program id (0x…) from thebook_pairs'),
    amount: bnStr.describe('Smallest-units to approve — the amount the next order escrows, no more'),
    confirm: confirmField,
  },
  tool(async (b, { token, amount, confirm }) => {
    const human = checkSpend({ tokenId: token, raw: amount, confirm, what: 'Approval' });
    await b.spot.approve(token, BigInt(amount));
    return `Approved ${human} for the exchange to escrow.`;
  }),
);
server.tool('thebook_allowance', "This wallet's current allowance to the exchange for a token, and its balance.",
  { token: z.string().describe('Token VFT program id (0x…)') },
  tool(async (b, { token }) => ({ allowance: (await b.spot.allowance(token)).toString(), balance: (await b.spot.balanceOf(token)).toString() })),
);

// ── Spot trading ──
server.tool('thebook_place_limit', 'Place a resting limit order. Approve the escrow token first (quote for Buy, base for Sell).',
  {
    pairId: z.number().int(),
    side: z.enum(['Buy', 'Sell']),
    price: bnStr.describe('Quote smallest-units per whole base'),
    qty: bnStr.describe('Base smallest-units'),
    confirm: confirmField,
  },
  tool(async (b, { pairId, side, price, qty, confirm }) => {
    const pairs = await b.spot.pairs();
    const pair = pairs.find((p) => Number(p.id) === pairId);
    if (!pair) throw new Error(`No pair ${pairId}. Call thebook_pairs first.`);
    // A buy escrows quote (price × qty); a sell escrows base (qty).
    const escrowToken = side === 'Buy' ? pair.quote : pair.base;
    const escrowRaw = side === 'Buy'
      ? (BigInt(price) * BigInt(qty)) / 10n ** BigInt(pair.base_dec)
      : BigInt(qty);
    const human = checkSpend({ tokenId: escrowToken, raw: escrowRaw.toString(), confirm, what: `${side} limit order` });
    const oid = await b.spot.placeLimit(BigInt(pairId), side, BigInt(price), BigInt(qty));
    return { orderId: oid?.toString?.() ?? oid, escrowed: human };
  }),
);
server.tool('thebook_market_buy', 'Market-buy base tokens, spending at most maxQuote and receiving at least minBaseOut. Approve the quote token for maxQuote first.',
  {
    pairId: z.number().int(),
    qty: bnStr.describe('Base smallest-units to buy'),
    maxQuote: bnStr.describe('Max quote smallest-units to spend'),
    minBaseOut: bnStr.describe('Minimum base smallest-units to receive — your slippage bound. The order reverts and returns your budget if the book cannot meet it.'),
    confirm: confirmField,
  },
  tool(async (b, { pairId, qty, maxQuote, minBaseOut, confirm }) => {
    const pairs = await b.spot.pairs();
    const pair = pairs.find((p) => Number(p.id) === pairId);
    if (!pair) throw new Error(`No pair ${pairId}. Call thebook_pairs first.`);
    const human = checkSpend({ tokenId: pair.quote, raw: maxQuote, confirm, what: 'Market buy' });
    const oid = await b.spot.marketBuy(BigInt(pairId), BigInt(qty), BigInt(maxQuote), BigInt(minBaseOut));
    return { orderId: oid?.toString?.() ?? oid, spentAtMost: human };
  }),
);
server.tool('thebook_market_sell', 'Market-sell base tokens into the bids, receiving at least minQuoteOut. Approve the base token for qty first.',
  {
    pairId: z.number().int(),
    qty: bnStr.describe('Base smallest-units to sell'),
    minQuoteOut: bnStr.describe('Minimum quote smallest-units to receive — your slippage bound. The order reverts and returns your tokens if the book cannot meet it.'),
    confirm: confirmField,
  },
  tool(async (b, { pairId, qty, minQuoteOut, confirm }) => {
    const pairs = await b.spot.pairs();
    const pair = pairs.find((p) => Number(p.id) === pairId);
    if (!pair) throw new Error(`No pair ${pairId}. Call thebook_pairs first.`);
    const human = checkSpend({ tokenId: pair.base, raw: qty, confirm, what: 'Market sell' });
    const oid = await b.spot.marketSell(BigInt(pairId), BigInt(qty), BigInt(minQuoteOut));
    return { orderId: oid?.toString?.() ?? oid, sold: human };
  }),
);
server.tool('thebook_cancel_order', "Cancel one of this wallet's resting orders by id (refunds unfilled escrow to your claimable balance).",
  { orderId: z.number().int() },
  tool((b, { orderId }) => b.spot.cancelOrder(BigInt(orderId)).then(() => `Cancelled order ${orderId}.`)),
);
server.tool('thebook_my_orders', "This wallet's resting orders. Filled and cancelled orders are not retained on chain — they are in the event log.",
  {}, tool((b) => b.spot.myOrders()),
);

// ── Liquidity pools ──
server.tool('thebook_pools', 'List the AMM liquidity pools with their reserves and total shares.',
  {}, tool((b) => b.amm.pools()),
);
server.tool('thebook_quote_swap', 'Price a pool swap without sending it. Returns the output amount and the 0.3% fee.',
  {
    poolId: z.number().int(),
    tokenIn: z.string().describe('Token VFT program id (0x…) being paid in'),
    amountIn: bnStr.describe('Smallest-units to pay in'),
  },
  tool(async (b, { poolId, tokenIn, amountIn }) => {
    const q = await b.amm.quote(BigInt(poolId), tokenIn, BigInt(amountIn));
    return { amountOut: q.amountOut.toString(), fee: q.fee.toString() };
  }),
);
server.tool('thebook_pool_position', "This wallet's LP shares in a pool and what they currently redeem for. Fees are not paid out separately; they raise this redemption value.",
  { poolId: z.number().int() },
  tool(async (b, { poolId }) => {
    const p = await b.amm.position(BigInt(poolId));
    return { shares: p.shares.toString(), redeemsA: p.amountA.toString(), redeemsB: p.amountB.toString() };
  }),
);
server.tool('thebook_pool_swap', 'Swap through a liquidity pool, receiving at least minOut. Approve the input token first.',
  {
    poolId: z.number().int(),
    tokenIn: z.string(),
    amountIn: bnStr,
    minOut: bnStr.describe('Minimum output — your slippage bound. Reverts and returns your input if unmet.'),
    confirm: confirmField,
  },
  tool(async (b, { poolId, tokenIn, amountIn, minOut, confirm }) => {
    const human = checkSpend({ tokenId: tokenIn, raw: amountIn, confirm, what: 'Pool swap' });
    const out = await b.amm.swap(BigInt(poolId), tokenIn, BigInt(amountIn), BigInt(minOut));
    return { received: out?.toString?.() ?? out, paid: human };
  }),
);
server.tool('thebook_add_liquidity', 'Supply both sides of a pool and receive LP shares. Earns 0.3% of every swap, in proportion to your share. Carries impermanent loss: if the price moves you can end up with less than holding. Approve both tokens first.',
  {
    poolId: z.number().int(),
    amountA: bnStr, amountB: bnStr,
    minShares: bnStr.describe('Minimum shares to mint — the ratio can move before this lands'),
    confirm: confirmField,
  },
  tool(async (b, { poolId, amountA, amountB, minShares, confirm }) => {
    const pool = (await b.amm.pools()).find((p) => Number(p.id) === poolId);
    if (!pool) throw new Error(`No pool ${poolId}. Call thebook_pools first.`);
    const a = checkSpend({ tokenId: pool.token_a, raw: amountA, confirm, what: 'Liquidity deposit (side A)' });
    const bb = checkSpend({ tokenId: pool.token_b, raw: amountB, confirm, what: 'Liquidity deposit (side B)' });
    const shares = await b.amm.addLiquidity(BigInt(poolId), BigInt(amountA), BigInt(amountB), BigInt(minShares));
    return { shares: shares?.toString?.() ?? shares, deposited: `${a} + ${bb}` };
  }),
);
server.tool('thebook_remove_liquidity', 'Burn LP shares and take back your share of both reserves, including accrued fees. Never blocked, even while the venue is paused.',
  {
    poolId: z.number().int(),
    shares: bnStr,
    minA: bnStr.describe('Minimum of token A to accept'),
    minB: bnStr.describe('Minimum of token B to accept'),
  },
  tool(async (b, { poolId, shares, minA, minB }) => {
    const out = await b.amm.removeLiquidity(BigInt(poolId), BigInt(shares), BigInt(minA), BigInt(minB));
    return { returned: Array.isArray(out) ? out.map(String) : out };
  }),
);

// ── Settlement ──
server.tool('thebook_claim', 'Your withdrawable balance (fills + cancelled escrow) for a token, in smallest-units.',
  { token: z.string().describe('Token VFT program id (0x…)') },
  tool(async (b, { token }) => ({ claim: (await b.spot.claim(token)).toString() })),
);
// Withdrawing moves value toward the agent's own wallet, so it is not spend-capped.
server.tool('thebook_withdraw', 'Withdraw your claimable balance of a token back to your wallet. Omit amount to withdraw all of it.',
  {
    token: z.string().describe('Token VFT program id (0x…)'),
    amount: bnStr.optional().describe('Smallest-units to withdraw; omit for the full claimable balance'),
  },
  tool(async (b, { token, amount }) => {
    const got = await b.spot.withdraw(token, amount ? BigInt(amount) : null);
    return `Withdrew ${describe(token, got?.toString?.() ?? got)} to your wallet.`;
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  LIMITS_ON
    ? `thebook MCP server running (stdio). Spend limits: $${MAX_TRADE_USD}/trade, $${MAX_DAILY_USD}/day, confirm above $${CONFIRM_USD}.`
    : 'thebook MCP server running (stdio). Spend limits DISABLED.',
);
