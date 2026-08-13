# Integration research — third-party liquidity for swaps (RivrDEX) and perps

Research question: instead of bootstrapping our own liquidity, can thebook **route to a
third party's** liquidity — RivrDEX for swaps, and some external venue for perps — and
just submit/fetch orders through them?

Short answer:
- **Swaps → RivrDEX:** architecturally clean and same-chain, but **too early to rely on
  today** — only one live pair. A "watch + integrate when it grows" play, not a launch
  dependency.
- **Perps → third party:** **no Vara-native perps venue exists.** Routing to an external
  venue is technically possible (Hyperliquid's "builder codes" are purpose-built for it),
  but it moves custody, signing, and settlement **off Vara** — a strategic change to what
  thebook *is* for perps, not just a plumbing choice.

---

## 1. Swaps — RivrDEX

### What it is (verified)
- A Uniswap-v2-style AMM **live on Vara mainnet**, built as **Gear WASM / Sails
  programs** — the same tech stack as thebook, so integration is same-chain and native
  (no bridge, no EVM tooling). Standard `@gear-js` + Sails or Polkadot.js.
- **Factory + Pair model, no Router.** Swap, add-liquidity and remove-liquidity messages
  go **straight to the Pair program**. Each Pair holds both reserves and runs `x*y=k`.
- Swap fee **0.35%**. Configurable slippage tolerance on the taker side.
- Cross-chain deposits via Delora + the Vara bridge; assets are **wrapped** (wVARA,
  wUSDT).

### Deployed mainnet addresses (from RivrDEX docs)
| Contract | Program ID |
|---|---|
| Factory | `0x943b74e9655497ee984022c7ecd6c5016edacc8eaf3a372d81c95efa83dd3f21` |
| wVARA/wUSDT Pair | `0x038534fe3ec91c4a9b4074f14908bfeca6358da0515772a428d8c489fdd134a1` |
| wVARA token | `0x29c42c668012b1ce20720e4615229215023281ef4676fdc77bf047d7fbcb9d17` |
| wUSDT token | `0x4255ff4a87a4c13dc39f74ace8c4948bbef2f75fb639d66639a1cfcc99e6243e` |

### How thebook would integrate (proposed)
1. Read the Factory registry to enumerate live Pairs (base, quote, addresses).
2. **Quote:** read a Pair's reserves and apply `x*y=k` minus 0.35% to compute
   `amountOut` locally (no router/quote method needed).
3. **Swap:** VFT `approve` the input wrapped token to the Pair, then send the Pair's swap
   message. Same escrow/approval pattern we already need for our own spot CLOB.
4. Surface RivrDEX swaps in our UI/SDK/skill as a "market swap" route alongside our
   orderbook — thebook becomes the smart front-end / agent layer, RivrDEX is the pool.

### The reality check (why this is a *later* integration)
- **Only wUSDT is live, effectively one pair (wVARA/wUSDT).** RivrDEX docs state
  plainly that the DEX trades against wUSDT and "other bridged tokens can't be swapped
  yet." So routing swaps to RivrDEX today gives us **near-zero pair coverage**.
- **Contracts aren't public yet** — the only repo in the RivrDEX GitHub org is
  `mintlify-docs`. The docs point integrators to "IDL files from the source repository,"
  but that source isn't published. **We need the Pair/Factory IDL** to get exact method
  signatures; until then integration is blocked.
- Wrapped-token model: everything is w-tokens via the bridge; our stablecoin assumption
  (bridged USDT/USDC) must specifically mean **wUSDT / wUSDC** with RivrDEX's addresses.

### Verdict
Good strategic fit, wrong timing. **Do not make it a launch dependency.** Track pair
growth, get the IDL from the RivrDEX/Gear team, and integrate as a swap route once they
have depth across more than one pair.

---

## 2. Perps — routing to third-party liquidity

### The finding
There is **no perpetual-futures venue native to Vara**. RivrDEX is spot AMM only (no
perps). So "submit our perp orders to a third party and fetch back" necessarily means an
**off-Vara** venue.

### The model that matches the ask: Hyperliquid builder codes
The pattern the request describes — "submit orders there directly, fetch everything back"
— is exactly Hyperliquid's **builder-code** design:
- Hyperliquid is the deepest on-chain perps venue (~$432B monthly volume, 300+ markets),
  with a full **Info / Exchange / WebSocket API**.
- **Builder codes** let a third-party app place orders on behalf of users and **earn a
  builder fee** (this has paid out $40M+ to app builders). There's an MIT-licensed demo
  app covering the full approve → place → revoke lifecycle on testnet and mainnet.
- For AI agents this is an **excellent fit** — it's API-driven, exactly how our agents
  already operate.

### The catch (this is the strategic part, not plumbing)
Hyperliquid is **its own L1, not Vara**. Routing perps there means:
- **Custody leaves Vara.** Users' perp collateral (USDC) lives on Hyperliquid (bridged
  via Arbitrum), not in a Vara wallet.
- **Different keys / signing.** Hyperliquid uses Ethereum/EIP-712 signatures, not
  Substrate/Vara keys. Agents and users need an EVM key path.
- **thebook is no longer an on-chain Vara perps DEX** — it becomes a **front-end / agent
  orchestration layer over Hyperliquid**. That may be a perfectly good product, but it's
  a different claim than "on-chain perps on Vara."
- **Regulatory:** operating an interface that routes users into leveraged derivatives
  carries the same derivatives exposure we deferred with "spot-only v1." *Not legal
  advice — needs counsel.*

### Alternatives considered
| Option | Liquidity | On Vara? | Effort | Notes |
|---|---|---|---|---|
| Hyperliquid builder codes | Deepest in DeFi | No (its L1) | Medium | Best fit for the "route to a third party" ask; off-Vara custody |
| Jupiter Perps / other Solana | Deep | No (Solana) | Medium-High | Same off-chain-venue tradeoffs, Solana keys |
| Wait for a Vara-native perps venue | — | Yes | — | None exists today; can't plan around it |
| Build our own (deferred v2) | Ours to seed | Yes | High | Needs oracle, funded vault/reserve, funding rate, liquidations, capital |

### Verdict
If perps must ship without us providing capital, **Hyperliquid builder-code routing is the
realistic path** — and it's genuinely agent-friendly. But it is an off-Vara product
decision with custody and regulatory consequences. This is a **strategy call**, and it
stays consistent with our plan to keep perps out of v1.

---

## The assignment — open items to close before committing

**RivrDEX (swaps):**
1. Obtain the **Factory + Pair IDL** from the RivrDEX / Gear team (blocks any code).
2. Confirm the **full live pair list** and real **liquidity depth** on mainnet (is it
   still just wVARA/wUSDT?).
3. Confirm the exact **wUSDT / wUSDC** addresses match our bridged-stablecoin choice.
4. Prototype: read a Pair's reserves, compute a quote, do one testnet swap via Sails.
5. Clarify commercial terms / partnership (co-marketing, any integration support).

**Perps (external venue):**
1. Decide the **strategic question**: is an off-Vara, front-end-over-Hyperliquid perps
   product acceptable, or must perps be on-chain Vara?
2. If Hyperliquid: study builder-code approval flow, fee economics, and the EVM key path
   for both human and agent users.
3. Map the **custody + bridging** UX (Arbitrum USDC → Hyperliquid) for our users/agents.
4. Legal review of operating a **derivatives-routing interface**.
5. Compare against simply deferring perps until a Vara-native venue exists.

## Sources
- RivrDEX site & docs: https://rivrdex.io/ , https://rivrdex.io/docs/protocol/smart-contracts.md , https://rivrdex.io/docs/features/swapping.md , https://rivrdex.io/docs/getting-started/quickstart.md
- Vara Network announcements: https://x.com/VaraNetwork/status/1997119339900567840
- Hyperliquid builder codes / API: https://docs.chainstack.com/reference/hyperliquid-exchange-place-order , https://www.dwellir.com/blog/build-hyperliquid-trading-app-builder-codes
- Perps DEX landscape 2026: https://metamask.io/news/best-perps-dexs-in-2026
