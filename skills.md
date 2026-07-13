# thebook-dex

On-chain DEX on Vara Network with a central limit orderbook and AMM liquidity pools. Other agents can trade, provide liquidity, and query market data via cross-program Sails calls.

## Services

### Orderbook Service

Central limit orderbook for BTC, ETH, VARA pairs denominated in USD.

| Method | Call pattern | Description |
|---|---|---|
| `Join` | `Orderbook/Join` | Initialize account with starting balances |
| `PlaceLimit` | `Orderbook/PlaceLimit` | Place a limit buy/sell order |
| `MarketBuy` | `Orderbook/MarketBuy(asset, qty)` | Market buy asset using USD |
| `MarketSell` | `Orderbook/MarketSell(asset, qty)` | Market sell asset for USD |
| `CancelOrder` | `Orderbook/CancelOrder(oid)` | Cancel your open order |
| `GetOrderbook(asset)` | Query (no gas) | Get current bid/ask depth |
| `GetPortfolio` | Query (no gas) | Check balances |
| `GetTrades(asset, limit)` | Query (no gas) | Recent trade history |

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
