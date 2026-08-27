# thebook SDK

Trade **thebookdex** from inside your own agent. No website, no wallet extension.
Your agent signs the exact same on-chain calls the app does, so every order is
yours — the program keys everything off `msg::source()`.

thebookdex v1 is a **non-custodial spot CLOB** over real bridged VFT tokens on Vara
mainnet (plus cash-settled perps). You trade by escrowing real tokens per order:
approve the DEX on the token's own VFT program, place the order, then withdraw your
filled proceeds / cancelled escrow. There are no virtual balances.

## Install

```bash
npm install thebook-sdk
# or drop this folder into your agent and: npm install
```

Peer stack (Vara / Gear): `@gear-js/api`, `@polkadot/api`, `sails-js`. They're
listed as dependencies here. This package pins `@polkadot/api@12.4.2` alongside
`@gear-js/api@0.45.0`; if your project has its own versions, install with
`--legacy-peer-deps` (see `.npmrc`).

## Quick start

```js
import { connectTheBook, Side } from 'thebook-sdk';

const book = await connectTheBook({
  seed: process.env.VARA_SEED,             // your agent's account (this is its identity)
  programId: process.env.THEBOOK_PROGRAM_ID,
  node: 'wss://rpc.vara.network',          // default — Vara mainnet
});

// Curated markets, read live from chain. Each pair carries its token ids + decimals.
const [pair] = (await book.spot.pairs()).filter((p) => p.active);
const baseDec = Number(pair.base_dec), quoteDec = Number(pair.quote_dec);

// A BUY escrows QUOTE — approve the quote token once (a large allowance avoids
// re-approving every trade), then place the order.
await book.spot.approve(pair.quote, book.units(1_000_000, quoteDec));
const oid = await book.spot.placeLimit(
  pair.id, Side.Buy,
  book.units(2500, quoteDec),   // price: quote-units per one whole base
  book.units(0.01, baseDec),    // qty: 0.01 base
);

console.log(await book.spot.myOrders());
await book.spot.withdraw(pair.base);   // pull filled proceeds back to your wallet
```

Run the included demo (mainnet):

```bash
VARA_SEED="your twelve word mnemonic" \
THEBOOK_PROGRAM_ID=0x7c5dbc8a85a8526c3a0c4fe98f0fb286782849c4d130ff28d6b7b30d157c2484 \
npm run example
```

## Getting started

thebookdex is non-custodial: you trade the **real bridged tokens already in your
wallet**. There is no faucet and no starting balance.

1. Put a funded Vara **mainnet** account's seed phrase in `VARA_SEED` (the address is
   `book.address`). It needs a little VARA for gas — or point `voucherEndpoint` at the
   app's `/api/voucher` so gas is sponsor-paid and the agent needs no VARA of its own.
2. Hold the tokens you want to trade: **wUSDT / wUSDC** to buy, **wETH / wVARA** to sell.
3. `spot.approve(token, amount)` once per token, then place orders and `spot.withdraw`.

## API

`connectTheBook({ seed, programId, node?, idlPath?, voucherEndpoint? })` → `book`

**Spot** (`book.spot`)
- `approve(token, amount)` — approve the DEX to escrow a token (its VFT program id). Required before that token can back an order: quote for a buy, base for a sell.
- `placeLimit(pairId, side, price, qty)` → order id
- `marketBuy(pairId, qty, maxQuote)` / `marketSell(pairId, qty)`
- `cancelOrder(oid)`
- `withdraw(token)` — pull filled proceeds / cancelled escrow of a token back to your wallet
- `balanceOf(token)` / `allowance(token)` — your real VFT balance / current DEX allowance
- Reads: `pairs()`, `pair(pairId)`, `orderbook(pairId)` → `{ bids, asks }` of `{ price, qty }` (BigInt), `myOrders()`, `claim(token)`
- Admin/multisig: `listPair(base, quote, baseDec, quoteDec)`, `delistPair(pairId)`, `transferAdmin(newAdmin)`

**Perps** (`book.perps`) — cash-settled, wUSDT collateral. Built but **not yet enabled on mainnet** (no live mark keeper).
- `open(marketId, isLong, margin, leverage)` / `close(positionId)` / `liquidate(positionId)`
- Reads: `markets()`, `reserve()`, `positions(owner?)`, `liqPrice(positionId)`
- Keeper/admin: `setMark(marketId, price)`, `addMarket(symbol)`, `setCollateral(token)`, `setKeeper(who)`, `setMarketCap(marketId, maxOi)`, `fundReserve(amount)`, `withdrawReserve(amount)`

**Units** — amounts and prices are token **smallest-units** (u128), sized by each
token's decimals (wVARA 12, wETH 18, wUSDT/wUSDC 6):
- `book.units(0.01, 18)` → `10000000000000000n` (0.01 wETH)
- `book.toWhole(10000000000000000n, 18)` → `"0.01"`
- A limit `price` is **quote smallest-units per one whole base** (per 10^baseDec).

`side` ∈ `Side` (`Buy`/`Sell`).

**Gasless** — pass `voucherEndpoint` (or set `THEBOOK_VOUCHER_URL`) to the app's
`/api/voucher`; the agent's txs are then sponsor-paid. `book.gasless()` reports whether
a voucher was issued.

Every write waits for finalization and throws the program's own error
(`UnknownPair`, `InsufficientAllowance`, `NoMarkPrice`, …) if it rejects.

## Want an existing AI agent to trade on its own?

If you don't want to write integration code at all, use the
[thebook MCP server](../mcp) (the "skill pack"). It wraps this SDK and exposes
thebookdex as tools that Claude Desktop, Claude Code, Cursor, or any MCP-compatible
agent can call directly in natural language.

## On-chain agents (Rust)

If your agent is itself an on-chain program rather than an off-chain process, see
`agent/` in the repo — a reference program that registers via A2A on init and trades
when its keeper pokes it. This SDK is the off-chain path; the Rust agent is the
on-chain path. Both settle on the same DEX.
