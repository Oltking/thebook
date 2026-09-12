# thebookdex — Agent & Developer Integration Guide

On-chain central limit orderbook (CLOB) and constant-product AMM pools on **Vara Network** for humans and AI agents.

- **Program ID (Vara Mainnet):** `0x9e87de353298b224e9bc88352197552c3a73a9b4bf04807a848f8aa9098f9dec`
- **Network RPC:** `wss://rpc.vara.network`
- **Frontend App:** [https://thebookdex.xyz](https://thebookdex.xyz)
- **Agent Skill Pack:** [https://github.com/Oltking/thebook-skills](https://github.com/Oltking/thebook-skills)

---

## 1. Quickstart with AI Agents

To teach any agent (Claude Code, Cursor, Codex, OpenClaw) to trade non-custodially on thebookdex:

```bash
# 1. Install wallet CLI and add the skill pack
npm install -g vara-wallet
npx skills add Oltking/thebook-skills

# 2. Create an encrypted agent wallet (seed is never exposed)
vara-wallet wallet create --name agent
```

Gas is sponsored via Vara vouchers; agents only need their trading tokens.

---

## 2. Sails Services & Methods

thebookdex v1 is completely **non-custodial**: orders escrow real VFT tokens during execution, and proceeds settle to withdrawable balances.

### Spot Service (`Spot`)

| Method | Call Pattern | Description |
|---|---|---|
| `GetPairs` | `Spot/GetPairs()` (Query) | List all curated markets (pair id, base, quote, decimals) |
| `GetOrderbook` | `Spot/GetOrderbook(pair_id)` (Query) | Read current bid/ask price levels and depth |
| `PlaceLimit` | `Spot/PlaceLimit(pair_id, side, price, qty)` | Place a resting limit order (approve token first) |
| `MarketBuy` | `Spot/MarketBuy(pair_id, qty, max_quote)` | Immediate market buy bounded by maximum quote |
| `MarketSell` | `Spot/MarketSell(pair_id, qty)` | Immediate market sell |
| `CancelOrder` | `Spot/CancelOrder(order_id)` | Cancel resting order and credit escrow to claims |
| `GetMyOrders` | `Spot/GetMyOrders()` (Query) | Active open orders for caller |
| `GetClaim` | `Spot/GetClaim(token)` (Query) | Check claimable / withdrawable balance |
| `Withdraw` | `Spot/Withdraw(token)` | Withdraw claimable balance back to wallet |

### AMM Service (`Amm`)

Constant-product AMM (`x·y=k`) with a 0.3% fee accrued directly to pool reserves.

| Method | Call Pattern | Description |
|---|---|---|
| `GetPools` | `Amm/GetPools()` (Query) | List all active liquidity pools and reserves |
| `Swap` | `Amm/Swap(pool_id, token_in, amount_in, min_out)` | Swap tokens with slippage protection |
| `AddLiquidity` | `Amm/AddLiquidity(pool_id, amount_a, amount_b, min_shares)` | Deposit both tokens to mint LP shares |
| `RemoveLiquidity` | `Amm/RemoveLiquidity(pool_id, shares, min_a, min_b)` | Burn shares and reclaim reserves |

### Perps Service (`PerpsV1`)

Cash-settled perpetual futures over wUSDT collateral. *(Requires audit before mainnet launch; currently gated by zero reserve coverage).*

| Method | Call Pattern | Description |
|---|---|---|
| `GetMarkets` | `PerpsV1/GetMarkets()` (Query) | Active perps markets and funding rates |
| `OpenPosition` | `PerpsV1/OpenPosition(market_id, is_long, margin, leverage)` | Open position (leverage ≤ 5) |
| `ClosePosition` | `PerpsV1/ClosePosition(position_id)` | Close position at current mark |
| `Liquidate` | `PerpsV1/Liquidate(position_id)` | Liquidate an under-collateralized position |

---

## 3. Developer SDK & MCP Server

- **JavaScript / TypeScript SDK:** [`thebook-sdk`](./sdk) (`npm install thebook-sdk`)
- **Model Context Protocol Server:** [`@thebookdex/mcp`](./mcp) — MCP tools for desktop and coding assistants with spend limits and confirmation prompts.

---

## 4. Curated Mainnet Tokens (VFT)

| Symbol | Program ID | Decimals |
|---|---|---|
| **wVARA** | `0x29c42c668012b1ce20720e4615229215023281ef4676fdc77bf047d7fbcb9d17` | 12 |
| **wETH** | `0xde45bdbb0345919a11561d43a5082e0b25061d4a2c6eb80009c1cfbccb80d0de` | 18 |
| **wUSDT** | `0x4255ff4a87a4c13dc39f74ace8c4948bbef2f75fb639d66639a1cfcc99e6243e` | 6 |
| **wUSDC** | `0xd1de816d7dce6439504552686ab333e5b7302b1549763656b30af1f8a5871b6a` | 6 |
