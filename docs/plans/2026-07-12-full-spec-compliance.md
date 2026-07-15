# thebookdex → Full DEX Spec Compliance Plan

**Date:** 2026-07-12
**Goal:** Bring thebookdex into compliance with the *Vara Network – Spot + Perpetual Futures DEX* spec v1.0.
**Target:** Production-grade, true actor-model architecture, real non-custodial VFT custody, full perps.

---

## 0. Current-state baseline (what we're starting from)

- **One monolithic Sails program** `thebook` with two services (`OrderbookService`, `AmmService`) sharing a single `RefCell<DexState>` (`app/src/state.rs`).
- **Virtual balances**: `join` mints `INITIAL_*` funds; no real token custody. → simulation, not non-custodial.
- **AMM**: correct constant-product logic, LP = `sqrt(a*b)`, 0.3% fee, slippage guard. *Reusable.*
- **Orderbook**: working CLOB matching. *Reusable, out-of-scope for the core spec but a differentiator to keep.*
- **Oracle**: single cross-program call to VaraBridge, no validation.
- **Perps**: none on-chain (frontend leverage is cosmetic — `TradeView.tsx:89`).
- **No** Factory / Risk / Governance actors, **no** deferred messages, **no** insurance fund.

The spec's two mandatory structural requirements we currently violate:
1. **Actor isolation** — "No monolithic contract. Every core component an independent program."
2. **Non-custodial VFT custody** — real deposits/withdrawals, LP tokens as VFT.

Everything below is sequenced so each phase produces a deployable, testable increment.

---

## Phase A — Workspace & actor scaffolding (foundation)

Convert the single-crate app into a multi-program workspace. Each actor = its own crate compiling to its own WASM.

### A.1 Restructure workspace
```
programs/
  factory/        (new)   — deploys & registries pools/markets
  spot-pool/      (new)   — one instance per pair (extracted from amm.rs)
  perps-market/   (new)   — one instance per market
  risk-clearing/  (new)   — margin, liquidation, insurance fund
  oracle/         (new)   — validated price aggregation
  governance/     (new)   — timelock + parameter control
  gateway/        (new)   — agent batch/query facade (keep orderbook here or standalone)
shared/           (new)   — common types (Asset, ContractError, events), no_std lib crate
```
- Move `app/src/types.rs` → `shared/src/lib.rs`; every program depends on `shared`.
- Keep the existing `app` orderbook as a standalone program (`programs/orderbook/`) — it's a legitimate CLOB differentiator and already works.
- Update root `Cargo.toml` `members`, and each program gets its own `build.rs` emitting its own IDL.

**Deliverable:** workspace builds; each program has a hello-world `new()` + IDL. No behavior yet.

### A.2 Code-generated clients
- Each program's `build.rs` produces an IDL; generate a client crate per program (mirror existing `client/`) so actors can call each other type-safely instead of hand-encoding routes.
- Replace the hand-rolled `RawPayload`/`SailsReply` pattern with generated clients where both ends are ours; keep `RawPayload` only for the untyped agent gateway.

---

## Phase B — Real VFT custody (non-custodial correctness)

This is the precondition for the whole thing being a real DEX rather than a simulation.

### B.1 Token layer
- Adopt Vara VFT standard for each traded asset (BTC/ETH/VARA/USDC as VFT programs, or use existing testnet VFTs).
- Replace `Agent { usd, btc, eth, vara }` internal balances with **custody accounting against real VFT transfers**:
  - `deposit(asset, amount)` — program calls `Vft/TransferFrom(user → program)`, credits internal ledger.
  - `withdraw(asset, amount)` — debits ledger, calls `Vft/Transfer(program → user)`.
- Remove `INITIAL_*` minting from `join`. `join` becomes identity/registration only.

### B.2 LP tokens as VFT
- Each spot pool mints a real VFT LP token (or a VFT-compatible share program) instead of the internal `LpPosition` struct.
- `add_liquidity`/`remove_liquidity` mint/burn LP VFT.

**Deliverable:** a spot pool that takes real VFT deposits, swaps, and pays out real VFT. Non-custodial end to end.
**Tests:** deposit→swap→withdraw round-trips; LP mint/burn conservation; reentrancy safety across the async VFT calls (state committed before external transfer, or checked-effects-interactions).

> ⚠️ Async custody introduces cross-message reentrancy surface the current sync code doesn't have. Every handler that awaits a VFT call must finalize internal state **before** the external transfer, and re-validate on resume.

---

## Phase C — Factory actor

- `create_spot_pool(asset_a, asset_b)` → deploys a new `spot-pool` program instance (via `ProgramGenerator`/`CreateProgram`), seeds initial liquidity, registers it.
- `create_perps_market(base, params)` → deploys a `perps-market` instance wired to risk + oracle.
- `registry`: `list_pools()`, `list_markets()`, `get_pool(pair)`, dedupe (port existing `PoolExists` check).
- Permissioning: permissionless spot pools; governance-gated perps markets (matches spec).

**Deliverable:** Factory deploys pools/markets on demand; registry queryable.

---

## Phase D — Oracle Integrator actor

Harden the single VaraBridge call into a real oracle actor:
- Aggregate ≥1 sources with **median + deviation check + staleness/timestamp guard** (spec §6).
- `get_price(market) -> (price, confidence, updated_block)` with an **acceptable price band**; reject stale/deviant.
- Cache recent prices with timestamps for funding-rate math.
- Deferred-message refresh loop to keep the cache warm.

**Deliverable:** oracle actor other programs query; rejects manipulated/stale prices.

---

## Phase E — Perps market + Risk & Clearing (the missing half)

GMX-style pool-as-counterparty model (spec-recommended for faster launch).

### E.1 perps-market actor (per market, e.g. BTC-PERP)
State: `collateral_reserves, long_oi, short_oi, utilization, accrued_borrow_fees, insurance_ref`.
Messages:
- `deposit_liquidity` / `withdraw_liquidity` (LPs are counterparty; VFT-backed).
- `open_position(direction, leverage, collateral)` — price from Oracle actor, OI-cap check vs utilization.
- `close_position` — PnL settled at oracle price.
- `adjust_margin(add/remove)`.
- Utilization-based borrow fee accrual.

### E.2 risk-clearing actor
- Maintenance-margin checks, liquidation thresholds, **partial liquidation** preferred (anti-cascade).
- **Insurance fund** (seeded from liquidation fees + protocol cut); ADL as last resort.
- **Funding rate**: periodic longs↔shorts settlement based on OI imbalance / premium to spot.
- Isolated vs cross margin flag per market.

### E.3 Deferred messages (spec-mandatory automation)
- Scheduled **funding settlement** via `exec::wait`/deferred send + self-wake loop.
- Scheduled **liquidation sweeps** and **stop/limit/TWAP** triggers.
- This is where Vara's deferred-message feature finally gets used — currently zero usage.

**Deliverable:** open/close leveraged long & short, funded periodically, liquidated automatically, bad debt absorbed by insurance fund.
**Tests (spec §10):** funding cycles; liquidation at 2x/10x/50x; insurance-fund depletion; cascade stress; high-utilization OI caps.

---

## Phase F — Governance / Timelock actor

- Parameter control (fees, leverage caps, new-market approval) behind a **timelock**.
- Upgrade path for logic actors via governance vote + timelock (spec §6: "no admin keys after deployment").
- Migrate the current single `admin: ActorId` (`state.rs:10`) to governance-owned.

---

## Phase G — Agent Gateway actor

- Keep/extend `call_agent_service` as a dedicated gateway program.
- Add **batch operations**, structured **callbacks**, and read-model **state queries** optimized for agents (spec §8).
- Publish an **Agent SDK** + example Rust agent (arb, LP-rebalance, liquidation-monitor bots) — matches your existing `AgentStrategy` enum and `agentBrief.ts`.
- Agent leaderboard already exists (`get_leaderboard`); extend to "Top Agent LP".

---

## Phase H — Frontend alignment

Current frontend is strong; changes needed:
- **Perps trading panel**: real margin, funding-rate display, liquidation-price calc (replace the cosmetic leverage in `TradeView.tsx`/`usePositions.ts`).
- **Deposit/withdraw UX** for VFT custody (new — today there's none).
- **LP dashboard**: real earned fees + APY from on-chain events.
- **Simulation mode** for orders/liquidations (spec §9).
- Point hooks at the new multi-program IDs (Factory registry → per-pool/market programs) instead of one program ID.

---

## Phase I — Security & QA (non-negotiable, spec §6/§10)

- Unit tests per actor; integration tests across actors; perps simulations.
- Testnet deploy of the full actor mesh; real agent testing.
- Oracle-manipulation, liquidation-cascade, funding-volatility stress suites.
- Prep for ≥2 external audits + Immunefi bug bounty.
- Consider formal verification on risk/liquidation module.

---

## Sequencing & dependencies

```
A (workspace) ─┬─> B (VFT custody) ─┬─> C (Factory) ──> E (Perps+Risk) ──> F (Gov) ──> I
               └─> D (Oracle) ──────┘                      ▲
                                     G (Gateway) ──────────┘  (parallel after B)
H (frontend) tracks B, E, C as they land.
```

**Critical path:** A → B → C → E. Oracle (D) and Gateway (G) can proceed in parallel once A lands. Governance (F) and full security (I) close it out.

## Rough effort (aligns to spec roadmap Phases 1–3)
- A: 1 wk · B: 1.5 wk · C: 0.5 wk · D: 0.5 wk · E: 2.5 wk (largest) · F: 0.5 wk · G: 0.5 wk · H: 1.5 wk (parallel) · I: ongoing + external.

## First concrete step (Phase A.1)
Extract `types.rs` into a `shared` crate and split `amm.rs` into a standalone `spot-pool` program — smallest change that starts the actor decomposition without breaking the working orderbook. Everything else builds on that.
```
