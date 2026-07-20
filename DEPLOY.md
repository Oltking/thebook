# Deploying thebookdex to Vara Testnet

End-to-end steps to build the contract, deploy it to Vara testnet, and point the
frontend at the new program.

## 0. Prerequisites

- Rust toolchain from `rust-toolchain.toml` — **pinned to 1.95.0** (see note below).
  `rustup` reads the file and auto-installs the pinned channel, the `rustfmt`/`clippy`
  components, and the `wasm32v1-none` / `wasm32-unknown-unknown` targets on first build.
- [`wasm-opt`](https://github.com/WebAssembly/binaryen) on your `PATH` (from Binaryen)
  to produce a size-optimized `thebook.opt.wasm`. Install via `brew install binaryen`
  (macOS) or the Binaryen releases page.
- Node 18+ and the frontend dependencies installed (`cd frontend && npm install`).
- A **funded** testnet account. Get test VARA from the faucet:
  <https://idea.gear-tech.io/programs?node=wss://testnet.vara.network> → faucet,
  or the Vara testnet faucet bot.

> **Toolchain note.** The toolchain is pinned to **Rust 1.95.0** in
> `rust-toolchain.toml`. Rust 1.96 both (a) stopped passing `--allow-undefined` to
> `wasm-ld` and (b) emits a WASM binary the gear-core runtime in `sails-rs 0.10.4`
> rejects at execution time (`Execution(Unsupported)` — every on-chain message would
> revert). 1.95.0 is the last stable that builds a runnable Gear program here.
> `.cargo/config.toml` still re-passes `--allow-undefined` for defensive builds.
> Do not bump the channel without also upgrading `sails-rs`/gear deps and re-running
> `cargo test --release`.

## 1. Build the contract

```bash
cargo build --release
```

Artifacts:

- DEX WASM:   `target/wasm32-gear/release/thebook.opt.wasm`
- Token WASM: `target/wasm32-gear/release/thebook_token.opt.wasm` (the wrapped VFT)
- IDL:        `thebook.idl` (interface used by the frontend client and the deploy script)

Run the tests too — they must pass before deploying:

```bash
cargo test --release
```

## 2. Deploy

### Option A — scripted (recommended)

```bash
cd frontend
VARA_SEED="<your funded mnemonic>" \
NODE_ADDRESS=wss://testnet.vara.network \
npm run deploy
```

The script uploads the code, runs the `New` constructor, waits for the init reply,
and prints the **program id**. Keep that value.

### Option B — IDEA portal (no CLI)

1. Open <https://idea.gear-tech.io> and switch the node to
   `wss://testnet.vara.network` (top-right network selector).
2. Connect a wallet funded with testnet VARA.
3. **Upload program** → choose `target/wasm32-gear/release/thebook.opt.wasm`.
4. Provide the IDL (`thebook.idl`) when prompted and select the `New` constructor.
5. Submit, then copy the resulting program id.

## 2.5. Deploy the wrapped test tokens and register them

The DEX custodies real VFT tokens, not simulated balances. Deploy one token
program per traded balance (from `token/`, WASM `thebook_token.opt.wasm`), using the
`New(name, symbol, decimals, faucet_amount)` constructor. Suggested config (the
faucet amount is what each user claims once and then deposits):

| Balance | name / symbol | decimals | faucet_amount |
|---------|---------------|----------|---------------|
| USD     | `wUSDC`       | 6        | 100000        |
| BTC     | `wBTC`        | 6        | 100000        |
| ETH     | `wETH`        | 6        | 1000000       |
| VARA    | `wVARA`       | 6        | 1000000000    |

After deploying all four, register each with the DEX **from the admin (deployer)
account** by calling `Orderbook/SetToken(kind, token_program_id)` for each
`TokenKind` (`Usd`, `Btc`, `Eth`, `Vara`) — via the IDEA portal or a script. Verify
with the `Orderbook/GetTokens` query; deposits are rejected until a kind is set.

## 2.6. Turn on perpetual futures (mark-price keeper + house reserve)

Perps settle PnL and liquidations at an **on-chain mark price** and pay profits
from a **house reserve**, so two admin steps bring them online:

1. **Seed the reserve.** As the admin, deposit USD (see the vault flow), then call
   `Perps/FundReserve(amount)` (amount in USD cents) to move some of your USD into
   the house reserve that pays trader profits. Query it with `Perps/GetReserve`.
2. **Run the price keeper.** It pushes live BTC/ETH/VARA prices on-chain every few
   seconds via `Perps/SetMarkPrices` (admin-only):

   ```bash
   cd frontend
   VARA_SEED="<admin seed>" \
   PROGRAM_ID=<DEX program id> \
   NODE_ADDRESS=wss://testnet.vara.network \
   npm run keeper
   ```

Without a published mark price, opening a position returns `NoMarkPrice`; without a
funded reserve, winning closes are capped at what the reserve can pay.

## 3. Wire the frontend to the new program

```bash
cd frontend
cp .env.example .env
```

Edit `.env`:

```
VITE_NODE_ADDRESS=wss://testnet.vara.network
VITE_PROGRAM_ID=<DEX program id from step 2>
VITE_NETWORK_NAME=Vara Testnet
VITE_TOKEN_USD=<wUSDC program id from step 2.5>
VITE_TOKEN_BTC=<wBTC program id from step 2.5>
VITE_TOKEN_ETH=<wETH program id from step 2.5>
VITE_TOKEN_VARA=<wVARA program id from step 2.5>
```

Until all four `VITE_TOKEN_*` ids are set, the onboarding "claim starting balances"
step and the Portfolio deposit/withdraw controls stay hidden.

Then run locally or build:

```bash
npm run dev      # http://localhost:5173
npm run build    # production bundle in dist/
```

For Vercel, set the same three `VITE_*` variables in the project's Environment
Variables instead of committing `.env`.

## 4. Smoke test

1. Connect a wallet (the deployer account is the program **admin** — only it can
   register token addresses and manage autopilot).
2. Create your agent (**Join** — a one-time identity registration; it grants **no**
   free balance).
3. Claim starting balances: the onboarding "Claim starting balances" step (or the
   Portfolio deposit controls) runs claim → approve → deposit for each token.
   Confirm the portfolio reflects the deposited amounts.
4. Place a limit order, run a market order against it, and confirm balances update.
5. Create an AMM pool, add liquidity, and swap.
6. Withdraw an asset from the Portfolio and confirm the wrapped tokens return to
   your wallet.
7. With the keeper running and the reserve funded (§2.6), open a Long on the
   Futures tab, watch PnL move with the mark, and close it.

If all seven succeed, the testnet deployment is good.

## Data & indexing

The frontend reads market data two ways, so no external indexer is required to
launch:

- **Live updates** via Gear event subscriptions (`Trade`, `SwapExecuted`,
  `OrderPlaced`, …) — see `subscribeTo*Event` in `frontend/src/lib/sails.ts`.
- **Recent history** via on-chain queries (`GetTrades`, `GetOrderbook`,
  `ListPools`). Trade history is intentionally bounded on-chain (`MAX_TRADES`) to
  cap state growth, so only recent trades are queryable.

If you later need deep historical analytics (full trade history, per-user PnL over
time), add an off-chain indexer (e.g. Subsquid) that ingests the same events into a
database and serve it alongside the on-chain queries — the event shapes above are
the ingestion contract.

## §4 · One-shot redeploy (deploy-all)

If the on-chain program is an older build (missing Perps / token vault), redeploy
the current source in one command. This deploys thebook, deploys + wires the four
wrapped tokens, registers the admin, and prints every env value.

```
cargo build --release                       # DEX + token wasm
cd frontend
VARA_SEED="<admin seed>" node scripts/deploy-all.mjs
```

Put the printed VITE_PROGRAM_ID and VITE_TOKEN_* into frontend/.env, redeploy the
frontend, then start the mark-price keeper (required for futures):

```
node scripts/keeper.mjs
```

Optional: fund the perps house reserve (claims wUSDC, deposits, FundReserve):

```
node scripts/fund-reserve.mjs
```
