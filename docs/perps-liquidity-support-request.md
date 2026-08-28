# thebook — Perpetual Futures Liquidity ("Pools"): Support Request

**To:** Vara / Gear ecosystem team
**From:** thebook (thebookdex) team
**Re:** Guidance and support on the liquidity model that backs our perpetual futures
**Status:** Spot live on Vara mainnet; perps built and tested; liquidity-backing model is our open question

---

## 1. Summary of the ask

We have built and deployed **thebook**, a non-custodial spot exchange on Vara mainnet, and
we have a working **perpetual-futures** engine ready to switch on. The one part we want the
ecosystem's help with is the **liquidity that backs perps** — the "pool" that pays winning
traders. As a new team we do not have a large treasury to seed a deep house reserve, and we
want to launch perps in a way that is **solvent, sustainable, and low-risk to us** while
still collecting trading fees.

We are weighing two models (Sections 4–5). We would value the team's guidance on which fits
Vara best, whether any **Vara-native liquidity-pool / vault primitive** exists to build on,
and whether **grant, market-maker, or oracle support** is available. Our specific requests
are in Section 6.

## 2. What we've built (context)

- **Spot CLOB, live on mainnet** — program id
  `0xf6080c9cdf99b3e0fdac2ded2b0333c2e077e2c41db7a734abab6b082b1a2774`.
  Non-custodial: orders escrow the user's **real bridged VFT tokens** (ETH and VARA vs
  wUSDT / wUSDC), fills settle to a claimable balance, users withdraw on demand.
- **Gasless** — user and agent transaction fees are sponsored via a Vara voucher.
- **Built for people and AI agents** — a public skill pack + SDK let autonomous agents
  trade the same book as humans.
- **Perps engine (built, 50+ tests passing)** — cash-settled perpetual futures sharing the
  spot settlement layer: keeper mark price, isolated margin, long/short with leverage,
  permissionless liquidation at maintenance margin. We have added a **0.1%/side trading
  fee** and **per-market open-interest caps**. What remains undecided is the **capital
  model that backs it** — the subject of this document.

## 3. The core problem

A perpetual future needs a counterparty. When a trader wins, someone must pay them. The two
honest ways to source that are (a) a **liquidity pool / reserve** that acts as counterparty,
or (b) **hedging** each position on an external venue so an outside market pays the winner.
Both require capital and risk management. We want to pick the model that lets a
capital-light team launch safely and scale.

## 4. Approach A — On-chain liquidity pool / reserve (GMX-style)

**How it works.** The protocol holds a reserve (a liquidity pool) that is the counterparty
to every position. Winners are paid from the pool; losers' margin flows into it. Revenue
comes from a **trading fee** (we have implemented 0.1%/side), and can be extended with a
**borrow/utilization fee** and a **funding rate**. We bound risk with **open-interest and
skew caps** sized to the pool, so the worst-case loss is known and capped. In a mature
version, third-party **liquidity providers** deposit into the pool and earn the fees (a
GLP-style LP token), which removes the need for the team to supply all the capital.

**Pros.** Fully on-chain and non-custodial; instant fills (no need to find a matched
counterparty); fee revenue independent of who wins; risk is bounded and transparent; LPs can
eventually supply the capital.

**Cons / what we need help with.** It still needs real capital in the pool. With a small
initial reserve we must set tight caps, which limits volume at launch. A sustained one-sided
market can draw down the pool between fee accruals. Attracting external LPs needs an
incentive design and, ideally, ecosystem visibility.

## 5. Approach B — External hedging / "A-book" (mirror on large venues)

**How it works.** For every user position, the house opens the identical position on a large
external venue (a major CEX or perp DEX), staying delta-neutral. The external market's payout
funds the on-chain winner; the house keeps the trading fees and takes little directional
risk. This is the classic brokerage "A-book" model.

**Pros.** Much less directional risk to the house; less on-chain reserve capital needed to
absorb trader wins; deep external liquidity means we can offer size beyond our own balance
sheet; we still collect fees normally.

**Cons / open risks we want the team's view on.**
- **Capital is relocated, not removed** — we must post margin on the external venue, so we
  still need working capital (possibly more, to margin both sides).
- **Basis risk** — our contract settles user PnL at the **keeper mark**, while the hedge
  settles at the **external fill price**. Any divergence is a residual the house absorbs.
- **Custody & counterparty risk** — funds sit on an external venue; that venue is a trust
  and failure point.
- **Centralization & trust** — an operator must faithfully mirror trades off-chain, which
  weakens the trustless, on-chain guarantee for perps.
- **Regulatory surface** — holding user-linked funds and trading them on external venues
  looks like custodial/brokerage activity, a heavier legal category than a non-custodial
  DEX. (We recognise this needs qualified legal counsel.)
- **Latency & minimums** — the gap between the on-chain open and the external hedge is
  unhedged exposure; very small trades may not be economically hedgeable.

## 6. Where we would value the team's support

1. **Liquidity-pool primitive** — Is there a Vara-native shared-liquidity / vault standard
   (an LP-token vault like GLP) we can integrate or build on, rather than writing our own
   from scratch? Any reference implementations on Gear/Sails?
2. **Best-practice guidance** — For a capital-light launch, would you recommend the on-chain
   pool (Approach A) with tight caps, the hedged model (Approach B), or a hybrid? Are there
   ecosystem projects that have solved this we could learn from?
3. **Oracle infrastructure** — Recommended mark-price feeds / keeper patterns on Vara for
   perps settlement (we currently run our own keeper).
4. **Market-maker / LP introductions** — Connections to liquidity providers or market makers
   active on Vara who could seed the pool or provide two-sided depth.
5. **Grant / seed support** — Any ecosystem grant or liquidity-bootstrapping support to seed
   the initial reserve so we can open with meaningful caps.
6. **Technical review** — A review of our perps contract design (margin, settlement,
   liquidation, caps) ahead of an independent audit.
7. **If Approach B is viable on Vara** — Any existing bridge/exchange integration patterns,
   and the team's perspective on the custodial/regulatory implications for a Vara project.

## 7. Current status & specifics

- **Mainnet program id:** `0xf6080c9cdf99b3e0fdac2ded2b0333c2e077e2c41db7a734abab6b082b1a2774`
- **Spot markets live:** ETH/USDT, ETH/USDC, VARA/USDT, VARA/USDC
- **Perp markets configured:** ETH, VARA (collateral: wUSDT)
- **Perps engine:** cash-settled, keeper mark, isolated margin, liquidations, 0.1%/side fee,
  per-market OI caps — implemented and tested; **not yet enabled pending the liquidity model
  and a funded pool.**
- **Open decision:** the liquidity-backing model (Section 4 vs 5), which this request is
  about.

## 8. Contact / next steps

We're ready to walk the team through the contract and our numbers, and to adapt the design
to whatever liquidity primitive or support the ecosystem can offer. Our goal is a perps
launch that is solvent and safe for users from day one.
