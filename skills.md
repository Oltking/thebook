# thebook-dex

On-chain DEX on Vara Network with a central limit orderbook and AMM liquidity pools. Other agents can trade, provide liquidity, and query market data via cross-program Sails calls.

## Services

### Orderbook Service

Central limit orderbook for BTC, ETH, VARA pairs denominated in USD.

| Method | Call pattern | Description |
|---|---|---|
| `Join` | `Orderbook/Join(name, strategy)` | Register your agent identity. Grants **no** balance — fund via the vault (below) |
| `Deposit` | `Orderbook/Deposit(kind, amount)` | Credit an internal balance from real VFT tokens (approve the DEX first) |
| `Withdraw` | `Orderbook/Withdraw(kind, amount)` | Send an internal balance back out as real VFT tokens |
| `PlaceLimit` | `Orderbook/PlaceLimit(side, asset, price, qty)` | Place a limit buy/sell order |
| `MarketBuy` | `Orderbook/MarketBuy(asset, qty)` | Market buy asset using USD |
| `MarketSell` | `Orderbook/MarketSell(asset, qty)` | Market sell asset for USD |
| `CancelOrder` | `Orderbook/CancelOrder(oid)` | Cancel your open order |
| `GetTokens` | Query (no gas) | Registered VFT token ids as `(usd, btc, eth, vara)` |
| `GetOrderbook(asset)` | Query (no gas) | Get current bid/ask depth |
| `GetPortfolio` | Query (no gas) | Check internal balances |
| `GetTrades(asset, limit)` | Query (no gas) | Recent trade history |

`TokenKind` is `Usd | Btc | Eth | Vara`. `Asset` (tradeable) is `BTC | ETH | VARA`.

### Funding an agent (real tokens)

Balances are backed by real VFT tokens, not simulated. To fund an agent:

1. `Orderbook/GetTokens` → the four token program ids.
2. On the relevant token program: `Faucet/Claim` (once per account) to receive test
   tokens, then `Vft/Approve(dex_program_id, amount)`.
3. `Orderbook/Deposit(kind, amount)` — the DEX pulls the approved tokens via
   `Vft/TransferFrom` and credits your internal balance.

Withdraw reverses this: `Orderbook/Withdraw(kind, amount)` debits the internal
balance and sends the tokens back with `Vft/Transfer`.

### AMM Service

Automated market maker with constant product formula.

| Method | Call pattern | Description |
|---|---|---|
| `CreatePool` | `Amm/CreatePool(asset_a, asset_b)` | New liquidity pool |
| `AddLiquidity` | `Amm/AddLiquidity(pool_id, amount_a, amount_b)` | Provide liquidity |
| `RemoveLiquidity` | `Amm/RemoveLiquidity(pool_id, lp_amount)` | Withdraw liquidity |
| `Swap` | `Amm/Swap(pool_id, asset_in, amount_in, min_amount_out)` | Swap tokens |
| `ListPools` | Query (no gas) | List all pools |
| `GetPool(id)` | Query (no gas) | Get pool state |

### Perps Service

On-chain perpetual futures with isolated margin, settled at a keeper-published mark
price against a house reserve. Prices/margin are in **USD cents**; size is in asset
units (`1 asset = 100000`).

| Method | Call pattern | Description |
|---|---|---|
| `OpenPosition` | `Perps/OpenPosition(asset, is_long, margin, leverage)` | Open/add an isolated position (leverage ≤ 20) |
| `ClosePosition` | `Perps/ClosePosition(asset)` | Close at mark; returns `(payout, pnl)` cents |
| `Liquidate` | `Perps/Liquidate(owner, asset)` | Permissionless close when equity ≤ maintenance |
| `GetPositions(owner)` | Query (no gas) | `(asset, is_long, size, entry, margin, leverage, pnl)` rows |
| `GetMarkPrices` | Query (no gas) | `(btc, eth, vara)` mark prices in cents |
| `GetLiqPrice(owner, asset)` | Query (no gas) | Liquidation price in cents |

Mark prices are pushed by the admin keeper (`SetMarkPrices`); PnL is paid from /
absorbed by the admin-seeded reserve, so no balance is ever minted.

## How to call (cross-program)

Use the Sails route encoding pattern. Every Sails program echoes the route in the reply, so use `SailsReply<T>` to decode:

```rust
// Rust (gstd) — place a limit order
let mut payload = "Orderbook".encode();
payload.extend("PlaceLimit".encode());
payload.extend((Side::Buy, Asset::ETH, 100_000_000u64, 1u64).encode());

let result = msg::send_for_reply_as::<RawPayload, SailsReply<Result<u64, ContractError>>>(
    pid, RawPayload(payload), gas, 0,
).map_err(...)?.await.map_err(...)?.0;
```

For non-Rust callers, encode the payload as:
1. SCALE string `"Orderbook"` (compact length + UTF-8 bytes)
2. SCALE string `"PlaceLimit"` (compact length + UTF-8 bytes)
3. SCALE-encoded arguments

## Program ID

Set per deployment. On Vara testnet (`wss://testnet.vara.network`), use the ID
returned by the deploy step — see [DEPLOY.md](./DEPLOY.md).

## Website

https://thebookdex.vercel.app

## Source

https://github.com/deveier/thebook

## Track

Economy & Markets — on-chain DEX for agent-to-agent trading.
