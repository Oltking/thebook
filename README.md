# thebookdex

**A non-custodial spot order book on Vara Network**, with cash-settled perpetual
futures over the same collateral.

[![Build Status](https://github.com/deveier/thebook/actions/workflows/ci.yml/badge.svg)](https://github.com/deveier/thebook/actions)
[![Network](https://img.shields.io/badge/Vara-mainnet-brightgreen)](https://idea.gear-tech.io/programs?node=wss://rpc.vara.network)

> **Status: not open for deposits.** The program is undergoing audit remediation.
> A [full-stack security assessment](docs/audit-remediation.md) found three
> exploitable critical defects; all are fixed in this source, and the fixed build
> has **not yet been redeployed**. The program currently on mainnet still carries
> them and holds no funds. **Do not deposit into it.**
>
> Before real funds return: an independent professional audit, admin behind a
> multisig, and the rest of the [launch gate](MAINNET.md). See
> [docs/audit-remediation.md](docs/audit-remediation.md) for the tracker and
> [docs/incident-runbook.md](docs/incident-runbook.md) for current live status.

**Real funds, real risk.** Read the [risk disclosure](docs/risk-disclosure.md) and
[terms](docs/terms.md) before trading. This is not a regulated exchange, and nothing
here is financial advice.

---

## What it does

thebookdex is a fully on-chain exchange written in Rust/Sails. It has two services.

### Spot — a real central limit order book

- **Non-custodial.** The contract only ever holds tokens an open order has escrowed,
  or proceeds credited to your claimable balance. Both are backed 1:1 by tokens the
  program actually holds; you withdraw on demand.
- **Real bridged tokens** — wETH, wVARA, wUSDT, wUSDC — not internal balances.
- **Price-time priority matching** over a price-level index, so cost scales with the
  levels a trade touches rather than with every order ever placed.
- **Slippage bounds on market orders.** A market order states the worst fill it will
  accept and reverts, returning your escrow, if the book cannot meet it.
- **Claimable-balance settlement.** Fills credit a balance you withdraw, so no
  settlement path depends on an async transfer succeeding mid-match.

### Perps — cash-settled, house-backed

- Isolated margin up to **5×**, settled in the spot collateral token. Launching
  conservatively; the cap rises as the reserve and real volume grow.
- A keeper publishes mark prices, **bounded to a 10% move per update**; if the keeper
  stalls, positions can be closed at entry after roughly an hour, so collateral is
  never trapped.
- A **funding rate** charges the crowded side, and per-market open-interest caps plus
  a reserve coverage floor bound the house's exposure.
- The reserve backing open positions **cannot be withdrawn by the operator**.

### Safety properties worth naming

- **A global pause** that blocks new orders and positions but *never* blocks
  cancelling an order or withdrawing a balance.
- **Two-step admin handover** — propose, then accept — so a mistyped address cannot
  brick the venue.
- **Events on every settlement path**, which is the audit trail and the indexing
  surface.
- **A solvency invariant** the contract exposes for monitoring:
  `balanceOf(program) >= claims + escrow + reserve + dust`.

---

## Contract architecture

```
Program (thebook)
  ├── SpotService (spot.rs)
  │     ListPair · RelistPair · DelistPair · SetPaused · SweepDust
  │     ProposeAdmin · AcceptAdmin
  │     PlaceLimit · MarketBuy · MarketSell · CancelOrder · Withdraw
  │     GetPairs · GetOrderbook · GetMyOrders · GetClaim · GetSolvency
  │
  └── PerpsService (perps_spot.rs)
        SetCollateral · SetKeeper · AddMarket · SetMarketCap
        SetMark · FundReserve · WithdrawReserve
        OpenPosition · ClosePosition · Liquidate
        GetMarkets · GetReserveHealth · GetPositions · GetLiqPrice
```

Both services share one `SpotState`, so perp margin and PnL settle through the same
claimable balances as spot.

**What is deliberately absent:** the legacy virtual-balance services (`orderbook`,
`amm`, `perps`) and their `DexState`. They shared this program's account — and
therefore its real token balance — while running a ledger anyone could mint into.
They also carried `CallAgentService`, an unauthenticated cross-program call that
handed any caller the contract's signing authority. Both were removed, and a
regression test asserts they stay removed.

---

## Frontend

| View | Description |
|---|---|
| **Trade** | Chart · order book · order entry with percent-of-balance sizing and slippage bounds |
| **Perps** | Long/short with leverage, margin and approval, open positions with live PnL |
| **Portfolio** | Wallet balances, claimable balances, resting orders |

---

## Building & testing

```bash
# Contract — must build on Rust 1.95.0 (see rust-toolchain.toml)
cargo build --release
cargo test --release           # unit + gtest integration tests

# Frontend
cd frontend
npm install
npm run dev                    # localhost:5173
npm run build                  # typecheck + production build
npx vitest run                 # unit tests
```

CI runs contract fmt/clippy/tests, the frontend typecheck/lint/test/build,
`npm audit`, `cargo-deny`, and a secret scan.

---

## Operations

| Script | Purpose |
|---|---|
| `frontend/scripts/audit-probe.mjs` | Read-only: what a deployed program exposes and holds |
| `frontend/scripts/solvency-monitor.mjs` | Continuous solvency invariant + drop/coverage alerts |
| `frontend/scripts/deploy-mainnet.mjs` | Deploy and list the curated markets |
| `frontend/scripts/fund-reserve.mjs` | Approve and fund the perps reserve |
| `frontend/scripts/perps-keeper.mjs` | Publish mark prices (keeper key, not admin) |

Every script that signs requires `NODE_ADDRESS` explicitly — none defaults to a
network, so a signing action cannot land on the wrong chain.

---

## Agents

- **[`thebook-sdk`](sdk/)** — trade from your own agent (approve, place, withdraw).
- **[`@thebookdex/mcp`](mcp/)** — an MCP skill pack, with per-trade and daily spend
  limits and confirmation prompts on large orders.

---

## Deployment

See [DEPLOY.md](./DEPLOY.md). Set `VITE_NODE_ADDRESS`, `VITE_PROGRAM_ID` and
`VITE_NETWORK_NAME` in your Vercel project; `VITE_MAINTENANCE=1` takes the interface
offline without tearing down the deployment.

---

## License

MIT
