# Go live

Everything is deployed and verified. What remains is transferring funds and starting
two processes.

**Program:** `0xe7540b7c404234b4345720a43138f58ba4af7de9367ff8fd2b4428586daf66a3`
(Vara mainnet, deployed 28 August 2026 after the end-to-end rehearsal passed)

---

## State right now

| | |
|---|---|
| Spot | **Live.** 4 markets, unpaused. Books empty until liquidity arrives |
| Pools | **Live.** 4 AMM pools created, all empty. 0.3% fee to providers |
| Perps | **Closed** until the keeper publishes marks and the reserve is funded |
| Custodied funds | Zero |
| Admin | Single key, not yet a multisig |

Spot was proven on this exact program with real tokens: wrap → approve → place →
rest on the book → cancel → withdraw, ending with the wallet exactly where it
started. Perps were proven the same way on a throwaway instance of the same build
(`scripts/rehearsal.mjs`), including an unbacked-open refusal and a profitable close.

---

## 1 · Point the site at the new program `[you]`

In Vercel, set:

```
VITE_PROGRAM_ID = 0xe7540b7c404234b4345720a43138f58ba4af7de9367ff8fd2b4428586daf66a3
```

and redeploy. Until this is done the live site talks to a retired program.

While there, delete `GROQ_API_KEY`: the endpoint that used it was removed, so there is
no LLM key left in the system.

## 2 · Seed a pool `[you]`

This is what makes spot actually tradeable. The books are empty and there is no market
maker, so an AMM pool is the counterparty: once seeded, every order has something to
trade against, and you earn 0.3% of the flow.

Pools mirror the spot markets:

| Pool | Pair |
|---|---|
| 0 | wETH / wUSDT |
| 1 | wETH / wUSDC |
| 2 | wVARA / wUSDT |
| 3 | wVARA / wUSDC |

Seed one from the app's **Pools** tab (add liquidity, both sides), or through the SDK.
The ratio you deposit at *sets the opening price*, so use something close to the market
rate or arbitrage will take the difference immediately.

**Start small.** A pool with little liquidity moves a lot on small trades, and you carry
impermanent loss as the price moves. Size it as a market-making budget, not a deposit.

## 3 · Fund the perps reserve `[you]`

The reserve is the counterparty to every perp position, so perps stay closed until it
holds something.

**Collateral is wUSDT** (6 decimals). The admin account must hold the amount being
funded before running this:

```sh
cd frontend
NODE_ADDRESS=wss://rpc.vara.network \
AMOUNT=<smallest units, e.g. 10000000000 for 10,000 wUSDT> \
node scripts/fund-reserve.mjs
```

It reads the collateral token from the contract, checks the admin can cover the
amount, approves exactly that, funds, and prints the resulting on-chain reserve.

### Where the collateral comes from

The four tokens are **bridge representations of Ethereum ERC-20s**, confirmed on
chain by their own metadata:

| Vara token | Name reported on chain | Supply bridged so far |
|---|---|---|
| wUSDT | Bridged Tether USD | 10,582.53 |
| wUSDC | Bridged USD Coin | 1.00 |
| wETH | Bridged Wrapped Ether | 0.0256 |

So **ERC-20 USDT bridges into exactly the collateral this contract already uses.**
Decimals are 6 on both sides, so amounts carry over unchanged. No contract change and
no collateral decision is needed for that case.

Two things to weigh:

- **Prefer USDT over USDC on Vara today.** wUSDT has ~10.5k bridged and a proven path;
  wUSDC has a supply of 1, meaning essentially nothing has ever crossed. Being the
  first large transfer through a route is not where you want to discover a problem.
- **The bridge is lightly used.** Confirm capacity and the current official bridge
  route with the Vara team before moving a grant-sized amount, and test with a small
  transfer first.

> **If the grant is native VARA instead**, it cannot fund this reserve as configured.
> Either acquire wUSDT, or switch collateral to wVARA (`PerpsV1/SetCollateral`), which
> native VARA wraps into directly via `VftNativeExchange/Mint`. wVARA collateral means
> margin and PnL carry VARA price exposure. Decide before any position opens; changing
> collateral with positions open would strand them.

### Sizing it

The per-side open-interest caps are set to 25,000 wUSDT (ETH) and 10,000 wUSDT (VARA).
The contract refuses new positions below **120% coverage** of what the reserve already
owes, so the reserve bounds real capacity. Start well under the caps and raise both
together as volume justifies it.

## 4 · Start the keeper `[you]`

This is what opens perps. Do it **after** the reserve is funded.

`render.yaml` now defines **both** workers, so this is one blueprint action.

1. **Delete `thebook-market-runner`** in the Render dashboard. Its start script was
   removed with the legacy services, which is the `Cannot find module` error. Renaming
   in the blueprint does not rename an existing service, so it has to go manually.
2. **Render → New → Blueprint**, point it at this repo, apply. It creates
   `thebook-perps-keeper` and `thebook-solvency-monitor`.
3. Render will prompt for the two secrets marked `sync: false`:
   - `KEEPER_SEED` — the seed for `kGgGRKtWP77HbHVoVdZiBeTz8y92c1oh6t774Pnn8MFS9BwiG`.
     **Not the admin seed**; the contract rejects admin as a keeper.
   - `ALERT_WEBHOOK` — for the monitor, below.

   Everything else (`NODE_ADDRESS`, `THEBOOK_PROGRAM_ID`, intervals) is already in the
   blueprint.

If you would rather not use blueprints: **New → Background Worker**, connect the repo,
set **Root Directory** `frontend`, **Build Command**
`npm install && npm install --prefix ../sdk`, **Start Command**
`node scripts/perps-keeper.mjs`, then add the env vars listed in `render.yaml`.

The keeper key is already set on the contract and holds 50 VARA for gas. It has no
admin rights, and a single mark update is bounded to a 10% move.

## 5 · Start the solvency monitor `[you]`

Created by the same blueprint as `thebook-solvency-monitor`. It **signs nothing and
needs no seed**, so start it before funding the reserve rather than after: its job is
to notice the first time something is wrong.

### What to put in `ALERT_WEBHOOK`

An **incoming webhook URL** for wherever your team actually gets paged. The monitor
posts both `text` (Slack) and `content` (Discord) in one payload, so either works
without configuration:

- **Slack** — api.slack.com/apps → your app → *Incoming Webhooks* → *Add New Webhook
  to Workspace*, pick a channel. You get `https://hooks.slack.com/services/T…/B…/…`.
- **Discord** — channel → *Edit Channel* → *Integrations* → *Webhooks* → *New Webhook*
  → *Copy Webhook URL*. You get `https://discord.com/api/webhooks/…`.
- **Anything else** — it receives JSON with `level`, `message`, `program` and `at`
  alongside, so a generic endpoint or a PagerDuty/Opsgenie inbound integration works.

**It is optional.** Without it the monitor still runs and still detects everything;
alerts just go to the Render logs, which nobody is watching at 3am. The startup banner
says `alerts: CONSOLE ONLY` when it is unset, so this cannot be forgotten silently.

Treat the URL as a secret: anyone holding it can post into that channel.

To run it locally instead:

```sh
cd frontend
NODE_ADDRESS=wss://rpc.vara.network \
PROGRAM_ID=0xe7540b7c404234b4345720a43138f58ba4af7de9367ff8fd2b4428586daf66a3 \
ALERT_WEBHOOK=<somewhere a human is paged> \
node scripts/solvency-monitor.mjs
```

Asserts `balance >= claims + escrow + dust + reserve` per token every 30s, and alerts
on sudden balance drops, thin perp coverage, and unexpected pause changes. Add
`ONCE=1` to run a single check and exit non-zero on any alert, for a cron or uptime
probe.

---

## Still open, and honest about it

These are not blockers to trading, but they are real:

- **Admin is one key.** Hand it to an N-of-M multisig with `Spot/ProposeAdmin` then
  `AcceptAdmin` from the multisig. The multisig must be a Gear/Sails program that can
  send messages; a `pallet_multisig` account cannot call `AcceptAdmin`.
- **No independent professional audit.** The assessment that prompted this work was
  not one, and neither is the remediation.
- **No committed market maker.** Books start empty, which is what makes slippage
  bounds matter.

See [risk-disclosure.md](risk-disclosure.md), which says all of this to users too.

---

## Costs, measured

- An escrowing call burns **~0.77 VARA**.
- A trader needs **~3 VARA free** to place an order at all, because the gas limit must
  be reservable. Below that they get `InsufficientBalance`, which says nothing about
  gas. Worth putting in your user docs.

## If something goes wrong

[docs/incident-runbook.md](incident-runbook.md). The short version: `Spot/SetPaused(true)`
halts new orders while leaving cancel and withdraw open, and `VITE_MAINTENANCE=1` takes
the site down without touching the chain.
