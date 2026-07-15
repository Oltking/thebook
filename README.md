# thebookdex

**On-chain DEX on Vara Network** — Central Limit Orderbook + AMM Liquidity Pools.

[![Build Status](https://github.com/deveier/thebook/actions/workflows/ci.yml/badge.svg)](https://github.com/deveier/thebook/actions)
[![Live Demo](https://img.shields.io/badge/demo-thebookdex.vercel.app-blue)](https://thebookdex.vercel.app)
[![Network](https://img.shields.io/badge/Vara-testnet-orange)](https://idea.gear-tech.io/programs?node=wss://testnet.vara.network)

**Track:** Economy & Markets | **Hackathon:** [Vara A2A Season 1](https://agents.vara.network)

> **Status:** preparing for **Vara testnet** launch. Network and program ID are
> environment-driven (see [DEPLOY.md](./DEPLOY.md)); the frontend defaults to
> `wss://testnet.vara.network`.

---

## What it does

thebookdex is a fully on-chain decentralized exchange running on the Vara Network. It combines two trading models in a single Sails program:

**A) Central Limit Orderbook** — Exchange-style trading
- Place limit buy/sell orders at a specific price
- Execute market orders against the best available price
- Supports BTC, ETH, VARA — all quoted in USD
- Automatic on-chain order matching

**B) Automated Market Maker (AMM)** — Uniswap-style liquidity pools
- Create liquidity pools for any asset pair
- Add/remove liquidity as an LP provider
- Swap tokens with 0.3% fee using constant product (x·y=k) formula
- Earn fees proportional to LP share

**Oracle integration** — Live prices fetched from the [VaraBridge](https://github.com/Oltking/vara-trinity) oracle via cross-program call. Arbitrage opportunities between DEX price and oracle price are displayed in real time.

**Agent-to-agent interface** — Other Sails programs can call `CallAgentService` to route messages through thebookdex, making it composable in multi-agent pipelines. See [skills.md](./skills.md) for the full integration guide.

---

## Program ID

The program ID is set per-deployment. After deploying to testnet (see
[DEPLOY.md](./DEPLOY.md)), put the returned ID in `frontend/.env` as
`VITE_PROGRAM_ID` and view it on
[IDEA](https://idea.gear-tech.io/programs?node=wss://testnet.vara.network).

---

## Tech stack

| Layer | Technology |
|---|---|
| Smart contract | Rust · Sails RS v0.10.4 · WASM |
| Blockchain | Vara Network (wss://rpc.vara.network) |
| Frontend | React 18 · TypeScript · Vite 5 |
| Web3 | @gear-js/api · sails-js · Polkadot.js |
| Styling | CSS Modules · PWA (vite-plugin-pwa) |
| Deployment | Vercel |

---

## Contract architecture

```
Program (thebook)
  ├── OrderbookService (orderbook.rs)
  │     Join · PlaceLimit · MarketBuy · MarketSell · CancelOrder
  │     GetOrderbook · GetPortfolio · GetTrades · GetLeaderboard
  │     GetLivePrice (→ VaraBridge cross-program) · CallAgentService
  │
  └── AmmService (amm.rs)
        CreatePool · AddLiquidity · RemoveLiquidity · Swap
        ListPools · GetPool · GetLpPosition
```

Shared state: `DexState` (state.rs) — balances, orders, pools, trades, LP positions in a single `RefCell<DexState>`.

---

## Agent-to-agent integration

Any Sails program on Vara can call thebookdex directly. See [skills.md](./skills.md) for the full interface documentation including payload encoding, call patterns, and example Rust code.

Quick example — place a market buy from another program:

```rust
let mut payload = "Orderbook".encode();
payload.extend("MarketBuy".encode());
payload.extend((Asset::BTC, 100_000u64).encode()); // buy 0.001 BTC

msg::send_for_reply_as::<RawPayload, SailsReply<Result<String, ContractError>>>(
    THEBOOKDEX_PID, RawPayload(payload), gas, 0,
)?.await?.0
```

---

## Frontend

Five views, fully responsive (mobile · tablet · desktop):

| View | Description |
|---|---|
| **Trade** | 4-panel trading terminal: chart · orderbook · order entry · recent trades |
| **Swap** | AMM swap with real-time constant-product output calculation |
| **Pools** | Create pools, add/remove liquidity, view LP positions |
| **Portfolio** | Balances, net worth, open orders with cancel |
| **Leaderboard** | Top traders ranked by net worth |

---

## Building & testing

```bash
# Smart contract
cargo build --release          # builds WASM binary
cargo test --release           # runs all gtest integration tests

# Frontend
cd frontend
npm install
npm run dev                    # development server (localhost:5173)
npm run build                  # TypeScript check + production build
```

---

## Deployment

The frontend is deployed to Vercel. To deploy your own instance:

1. Fork this repo
2. Deploy the contract to testnet — see [DEPLOY.md](./DEPLOY.md)
3. Set `VITE_NODE_ADDRESS`, `VITE_PROGRAM_ID`, and `VITE_NETWORK_NAME` in your
   Vercel project (or a local `frontend/.env`, copied from `.env.example`)
4. Connect the `frontend/` folder to Vercel
5. Optionally add a Vercel KV store for shared oracle price caching

---

## License

MIT
