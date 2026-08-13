# v1 spot contract — design spec

The mainnet v1 contract is a **non-custodial spot CLOB** that escrows and settles **real
VFT tokens** over curated `TOKEN/USDT|USDC` pairs. This replaces the current
virtual-balance program. It reuses the existing price-time **matching engine** in
`app/src/orderbook.rs`; what changes is that escrow/settlement stop being internal-balance
edits and become **async cross-program VFT calls**.

We already have the building blocks: a full Sails **VFT** token (`token/src/lib.rs` —
`transfer`, `transfer_from`, `approve`, `balance_of`, allowances) and a matching loop that
already reasons about escrow and refunds.

---

## What is removed from today's contract
- The `Join` **$1,000 grant** (`orderbook.rs:114`, `INITIAL_USD`).
- The **virtual house**: `seed_house`, `INITIAL_HOUSE_*`, `reserve_usd`.
- **Internal `usd/btc/eth/vara` balances** in `DexState` — balances now live in users'
  own wallets / VFT contracts, not in our state.
- **Perps** (`perps.rs`), mark prices, and the keeper — deferred to v2.
- The 3 hardcoded assets — replaced by a dynamic curated pair registry.

## What is added
- A **pair registry**: `Pair { base: ActorId, quote: ActorId, base_decimals, quote_decimals }`,
  admin-gated `ListPair` / `DelistPair` behind the multisig admin.
- **Real escrow**: placing an order pulls the maker's tokens into the DEX via VFT
  `transfer_from` (needs a prior `approve`).
- **Async settlement**: fills move real tokens between parties.
- Per-pair, per-token **decimals** handling (each VFT declares its own decimals; the
  fixed `MICRO`/`ASSET_UNIT` scaling goes away).

---

## The one central decision: how fills settle

A real CLOB must hold a maker's tokens while their order rests (that is inherent — not the
"deposit account" we rejected; only *live order* tokens are ever held, cancel returns them
instantly). The open question is what happens to **proceeds when an order fills**:

### Option A — push-on-fill (fully non-custodial, heavier)
On every fill, immediately `transfer` proceeds to both parties. Nothing lingers in the
DEX. But a taker crossing N resting orders triggers **N async transfers inside one
message** — high gas, and any single VFT failure complicates an already-committed match.

### Option B — claimable settlement balance (Serum/Serum-style, robust) — RECOMMENDED
On fill, credit an **internal claimable balance** (real tokens already held in DEX escrow,
just re-attributed); the user pulls them out with an explicit `Withdraw` (one async
transfer they trigger). Escrow is still only ever live-order + unclaimed-proceeds, cancel
and withdraw are always available, so it stays effectively non-custodial — but settlement
is simple, synchronous internal accounting (like today's matching loop), and gas is
bounded. Downside: proceeds sit as a claim until the user withdraws (mild custody).

### Option C — hybrid
Option B accounting, plus an optional **auto-withdraw** flag on an order that does the
push at the end if it's cheap (single counterparty).

**Recommendation: B** (with C as a later nicety). It keeps the matching loop synchronous
and gas-bounded, confines async to two well-defined points — `PlaceLimit` (one
`transfer_from` in) and `Withdraw` (one `transfer` out) — and matches how battle-tested
on-chain CLOBs work.

---

## Data model (proposed)
```
Pair       { id, base: ActorId, quote: ActorId, base_dec: u8, quote_dec: u8, active: bool }
Order      { id, pair_id, trader, side, price, qty, filled, status }
// Claimable balances held in DEX escrow, per (user, token):
Claim      map (ActorId user, ActorId token) -> U256
```
No per-user asset/usd fields; the DEX only tracks live orders and claimable balances, both
backed 1:1 by tokens it actually holds.

## Message interface (Sails, async where noted)
| Message | Async | Notes |
|---|---|---|
| `ListPair(base, quote)` | no | admin/multisig only; reads decimals from each VFT |
| `DelistPair(pair_id)` | no | admin only; stops new orders, existing can cancel |
| `PlaceLimit(pair_id, side, price, qty)` | **yes** | `transfer_from` escrow in, then run matching, credit claims |
| `PlaceMarket(pair_id, side, qty)` | **yes** | same, no resting remainder |
| `CancelOrder(order_id)` | no* | returns escrow to claimable (or *async* direct refund) |
| `Withdraw(token)` | **yes** | one `transfer` of the caller's claimable balance out |
| `GetPair / GetPairs` | no | registry reads |
| `GetOrderbook(pair_id)` | no | reuse existing aggregation |
| `GetMyOrders / GetTrades / GetClaims` | no | reads |

## Async failure handling
- `PlaceLimit`: if the `transfer_from` reply fails (no allowance / insufficient balance),
  **abort before touching the book** — no order, no state change. Mirrors today's
  "reject before escrow" guard at `orderbook.rs:199`.
- `Withdraw`: debit the claim only **after** the `transfer` reply succeeds; on failure,
  leave the claim intact and return an error.
- Matching itself never calls out (Option B), so a partial-fill can't half-settle.

## Decimals
Price/qty scaling becomes per-pair from the VFTs' declared decimals (read at `ListPair`),
not the global `MICRO`/`ASSET_UNIT` constants. Quote math uses `U256` to avoid overflow
across arbitrary token decimals.

---

## Build order (incremental, each a commit)
1. Strip perps/house/grant/virtual balances; add the `Pair` registry + `ListPair`.
2. Add VFT escrow to `PlaceLimit` (async `transfer_from`) + `Withdraw`.
3. Port the matching loop to credit claimable balances instead of internal balances.
4. `CancelOrder` refund path.
5. `PlaceMarket`.
6. Reads (`GetPairs`, `GetOrderbook`, `GetClaims`).
7. Multisig admin gate on listing.
8. Full test coverage with a real VFT in `gtest` (deploy the token, approve, trade).
