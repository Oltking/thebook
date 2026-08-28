# thebook — Mainnet migration plan

The current program is a **testnet demo**: it grants free virtual USD on signup, holds
virtual BTC/ETH/VARA balances with no real backing, and settles perps against a virtual
house reserve. Going to mainnet is **not a config flip** — it is a rebuild of the value
model around real, wallet-held tokens.

This document records the locked decisions and the full task list to get there.

---

## v1 scope (locked decisions)

thebook mainnet v1 is a **non-custodial spot CLOB** on Vara mainnet.

| Decision | Choice |
|---|---|
| Product at launch | **Spot only.** Perps deferred to v2. |
| Balances | User's **real wallet VFT tokens** — no internal virtual balances, no deposit accounts. Connect wallet, see supported tokens. |
| Markets | Every pair is **TOKEN / USDT** or **TOKEN / USDC** (bridged stablecoin, address already exists on Vara). |
| Listing | **Curated** — we approve every pair, gated behind a multisig. |
| Order model | **On-chain escrow** — placing a limit order transfers the real VFT into the DEX contract; cancel/fill returns or settles it. Needs a token-approval flow. |
| Liquidity | **External market makers.** No house capital. Books may be thin until MMs arrive. |
| Trading fees | **None at launch.** |
| Gas | **Users pay their own** (connected wallet). No sponsor/voucher. |
| Users | **Humans (browser wallet) and AI agents, both first-class.** |
| Agent keys | **Encrypted local keystore + on-chain spend limits / keeper-authorized** model, so a leaked agent key can't drain everything. |
| Contract | **Full rewrite** for real custody from the ground up. |
| Admin authority | **N-of-M multisig** for listing and all admin actions. |
| Audit | **Professional audit before launch.** Launch-blocker. |

### Explicitly deferred to v2 (perps)
Oracle / keeper mark feed, perp counterparty model (peer-to-peer vs funded vault — **open
decision**), funding rate, liquidation engine, house reserve, and the associated
derivatives-regulation review. None of this is on the v1 critical path.

---

## Workstreams

### A. Smart contract — full rewrite  *(launch-blocker)*
- [ ] New program designed around **real VFT custody**, not the current internal
      `usd/btc/eth/vara` balances in `app/src/state.rs`.
- [ ] **Remove the `Join` grant.** `orderbook.rs:114-141` gifts `INITIAL_USD = $1,000`
      (`types.rs:332`) on signup — delete entirely; signup starts empty.
- [ ] **Remove the virtual house stockpile.** `INITIAL_HOUSE_*` (`types.rs:340-343`) and
      `seed_house`/`reserve_usd` (`state.rs:39-41`) — gone in v1 (no house).
- [ ] **Escrow on order placement.** `PlaceLimit` must `transfer_from` the maker's real
      token into the program; cancel refunds; a fill settles maker↔taker in real tokens.
      Requires the VFT `approve` → `transfer_from` pattern.
- [ ] **Arbitrary curated pairs**, not the 3 hardcoded assets. Market = (base VFT addr,
      quote = USDT or USDC addr). Admin-gated `ListPair` / `DelistPair`.
- [ ] **Preserve the price-time matching logic** from `orderbook.rs` where possible, but
      it now moves real tokens — every settlement path re-verified.
- [ ] Keep `overflow-checks = true`; re-audit every `as u128` cast and division for
      rounding-to-zero and precision-loss under real balances.
- [ ] Reentrancy / message-ordering review for async VFT cross-contract calls.
- [ ] **Emergency pause** switch (multisig-controlled) to halt trading on incident.
- [ ] Upgrade/migration story decided before deploy (proxy vs immutable).

### B. Stablecoin & listing
- [ ] Confirm and pin the **real bridged USDT/USDC VFT address** on Vara mainnet.
- [ ] Curated initial pair list + the multisig-gated listing flow.
- [ ] Per-token metadata (decimals!) — VFT decimals differ from the current fixed
      `MICRO`/`ASSET_UNIT` scaling; the price/qty math must read each token's real decimals.

### C. Liquidity (external MMs)
- [ ] Recruit external market makers before launch (thin books otherwise).
- [ ] MM-friendly API/SDK: fast quote/cancel, post-only orders, low-latency reads.
- [ ] Consider an MM incentive/rebate program (note: interacts with the "no fees" choice).

### D. Wallet & agent custody
- [ ] **Human path:** browser wallet connect (SubWallet / Talisman / polkadot.js) as a
      first-class flow. The current app's generated-seed agent flow becomes secondary.
- [ ] **Agent path:** keep `vara-wallet`'s encrypted keystore, but add **on-chain spend
      limits** and/or a **keeper-authorized / scoped-session** model so a compromised
      agent key can't drain the owner. Design the on-chain permission (`SetKeeper`-style).
- [ ] Update the skill pack so agents sign real-value trades safely (no raw seeds in
      plaintext, explicit risk warnings).

### E. Frontend / SDK / skills
- [ ] Rebuild balances view to read the **connected wallet's real VFT balances**, not
      program-internal balances.
- [ ] Token-approval UX before first order on a pair.
- [ ] Remove all "testnet / virtual balances / trade freely / free $1,000" copy — it
      becomes dangerously wrong. Affects `SKILL.md`, `README.md`, `prompts/trader-loop.md`,
      landing page, onboarding.
- [ ] SDK + MCP: real-token order flow, per-token decimals, no faucet/Join grant.

### F. Infra & config
- [ ] Replace **17 hardcoded `wss://testnet.vara.network`** references (SDK, frontend,
      scripts, skills) with the **mainnet RPC**, via env var, not a literal.
- [ ] New **Program ID** everywhere it's hardcoded: `SKILL.md`, `README.md`,
      `prompts/trader-loop.md`, SDK, `mcp/`, frontend `.env`, `render.yaml`.
- [ ] **Re-verify the Rust 1.95.0 pin against the mainnet runtime version** — the
      toolchain that produces a runtime-accepted WASM on testnet may differ on mainnet.
- [ ] Remove the gasless voucher/faucet path (users pay own gas) or hard-disable it.
- [ ] `render.yaml`: the market-runner (marks + house quotes) is a **perps/house**
      service — not needed for v1 spot. Retire or repurpose it.

### G. Security & audit  *(launch-blocker)*
- [ ] Independent professional audit of the escrow + matching contract **before** any
      real funds.
- [ ] Internal review + full test coverage of every settlement and refund path.
- [ ] Testnet dress rehearsal of the *new* contract with real VFT tokens.
- [ ] Monitoring/alerting: abnormal withdrawals, stuck escrow, contract errors.

### H. Governance
- [ ] Stand up the **N-of-M multisig**; make it the contract admin and listing authority.
- [ ] Move any treasury/authority key off the single Render env-var seed into the multisig.
- [ ] Document who holds keys and the signing process.

### I. Legal / ops
- [ ] Legal review (lighter for non-custodial spot than perps, but still confirm your
      jurisdiction's stance on operating the interface and curating listings). *Not legal
      advice — engage counsel.*
- [ ] Terms of service / risk disclosures; remove risk-free framing.
- [ ] Incident runbook + the pause switch from (A).
- [ ] Anti-abuse: signups are no longer free money, but curation and MM onboarding need
      process.

---

## Launch-blockers (must be true before mainnet)

> **This list was written, then shipped past.** The 27 August 2026 security
> assessment found all five unmet while the frontend was live on mainnet against
> real bridged tokens (finding C-04). Treat it as binding, not aspirational.
> Current state of each is tracked in [docs/audit-remediation.md](docs/audit-remediation.md).

| # | Blocker | Status |
|---|---|---|
| 1 | New custody contract written and **audited** | Written and remediated; **no independent audit yet** |
| 2 | Real bridged USDT/USDC address confirmed and pinned | Done — `docs/mainnet-addresses.md` |
| 3 | Multisig live and set as admin | **Not done** — admin is still a single key. Two-step `ProposeAdmin`/`AcceptAdmin` now exists to do it safely |
| 4 | At least one external MM committed so books aren't empty | **Not done** |
| 5 | All testnet endpoints, program IDs, and "free money" copy removed | Done — the free-money code itself is deleted, not just the copy |

Add a sixth, which the assessment made unavoidable:

| 6 | The remediated build is **redeployed** and the old program retired | **Not done** — the program on mainnet still carries C-01 |

## Suggested sequence
1. Confirm the stablecoin address + shortlist initial pairs.
2. Design + write the new escrow/matching contract (workstream A).
3. Stand up the multisig (H).
4. Full test coverage + testnet rehearsal with real VFTs (G).
5. Audit (G) — in parallel, build the frontend/SDK/agent-custody changes (D, E, F).
6. Recruit MMs (C).
7. Legal + ToS (I).
8. Mainnet deploy, listing, launch.
