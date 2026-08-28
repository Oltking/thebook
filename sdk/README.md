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

// A BUY escrows QUOTE. Approve exactly what this order needs, not a standing
// allowance: an allowance is only as safe as the contract holding it, and for an
// agent it means a confused or compromised key can spend the whole balance rather
// than one order's worth.
const price = book.units(2500, quoteDec);
const qty = book.units(0.01, baseDec);
const escrow = (price * qty) / 10n ** BigInt(baseDec);   // quote this order escrows
await book.spot.approve(pair.quote, escrow);
const oid = await book.spot.placeLimit(pair.id, Side.Buy, price, qty);

console.log(await book.spot.myOrders());
await book.spot.withdraw(pair.base);   // pull filled proceeds back to your wallet
```

Run the included demo (mainnet):

```bash
VARA_SEED="your twelve word mnemonic" \
THEBOOK_PROGRAM_ID=0x8ff92cabb35bdeec210f203f3afcb626e2db106a8362ffff4f5b7b344917fac4 \
npm run example
```

## Getting started

thebookdex is non-custodial: you trade the **real bridged tokens already in your
wallet**. There is no faucet and no starting balance.

1. Put a funded Vara **mainnet** account's seed phrase in `VARA_SEED` (the address is
   `book.address`). It needs a little VARA for gas — or point `voucherEndpoint` at the
   app's `/api/voucher` so gas is sponsor-paid and the agent needs no VARA of its own.
2. Hold the tokens you want to trade: **wUSDT / wUSDC** to buy, **wETH / wVARA** to sell.
3. `spot.approve(token, amount)` for what the next order escrows, place it, then
   `spot.withdraw` your proceeds.

## API

`connectTheBook({ seed, programId, node?, idlPath?, voucherEndpoint? })` → `book`

**Spot** (`book.spot`)
- `approve(token, amount)` — approve the DEX to escrow a token (its VFT program id). Required before that token can back an order: quote for a buy, base for a sell. **Approve per order**, not a large standing amount.
- `placeLimit(pairId, side, price, qty)` → order id
- `marketBuy(pairId, qty, maxQuote, minBaseOut)` / `marketSell(pairId, qty, minQuoteOut)` — the last argument is a **required slippage bound**: the worst fill you accept. If the book cannot meet it the order reverts and your escrow is returned. Passing `0` means "any price" and is almost never what you want on a thin book.
- `cancelOrder(oid)`
- `withdraw(token, amount?)` — pull proceeds / cancelled escrow back to your wallet; omit `amount` for the full balance
- `balanceOf(token)` / `allowance(token)` — your real VFT balance / current DEX allowance
- Reads: `pairs(offset?, limit?)`, `pair(pairId)`, `pairCount()`, `orderbook(pairId, depth?)` → `{ bids, asks }` of `{ price, qty }` (BigInt), `myOrders(offset?, limit?)`, `claim(token)`, `isPaused()`, `solvency(token)` → `{ escrow, dust, reserve }`
- Admin/multisig: `listPair(base, quote, baseDec, quoteDec)` (decimals are verified against each token and rejected on mismatch), `delistPair(pairId)`, `relistPair(pairId)`, `setPaused(paused)`, `sweepDust(token)`, `proposeAdmin(newAdmin)` + `acceptAdmin()` (two-step)

> **Resting orders only.** `myOrders()` returns orders currently on the book. Filled
> and cancelled orders are removed from contract state — their history is in the
> event log, so keep your own records if you need them.

**Perps** (`book.perps`) — cash-settled, wUSDT collateral, up to **5x**. Built but **not yet enabled on mainnet** (no live mark keeper).
- `open(marketId, isLong, margin, leverage)` / `close(positionId)` / `liquidate(positionId)`
- Reads: `markets()`, `reserve()`, `reserveHealth()` → `{ reserve, liability, coverageBps }`, `positions(owner?, offset?, limit?)`, `liqPrice(positionId)`
- Keeper/admin: `setMark(marketId, price)` (bounded to a 10% move per update, keeper key only), `addMarket(symbol, maxOi)` (**`maxOi` is required**), `setCollateral(token)`, `setKeeper(who)`, `setMarketCap(marketId, maxOi)`, `fundReserve(amount)`, `withdrawReserve(amount)` (capped by open liability)

> **The house is your counterparty.** Check `reserveHealth()` before opening: if the
> reserve is short, winning positions are paid only what it can cover. Opening is
> refused below a 120% coverage floor. Funding is charged continuously to the crowded
> side. See the [risk disclosure](https://github.com/Oltking/thebook/blob/master/docs/risk-disclosure.md).

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
