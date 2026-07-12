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

- WASM: `target/wasm32-gear/release/thebook.opt.wasm`
- IDL:  `thebook.idl` (interface used by the frontend client and the deploy script)

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

## 3. Wire the frontend to the new program

```bash
cd frontend
cp .env.example .env
```

Edit `.env`:

```
VITE_NODE_ADDRESS=wss://testnet.vara.network
VITE_PROGRAM_ID=<program id from step 2>
VITE_NETWORK_NAME=Vara Testnet
```

Then run locally or build:

```bash
npm run dev      # http://localhost:5173
npm run build    # production bundle in dist/
```

For Vercel, set the same three `VITE_*` variables in the project's Environment
Variables instead of committing `.env`.

## 4. Smoke test

1. Connect a wallet (the deployer account is the program **admin** — only it can
   manage oracle feeds / autopilot).
2. Click **Join** to receive starting balances.
3. Place a limit order, run a market order against it, and confirm balances update.
4. Create an AMM pool, add liquidity, and swap.

If all four succeed, the testnet deployment is good.
