# Go live

Everything is deployed and verified. What remains is transferring funds and starting
two processes.

**Program:** `0xf6080c9cdf99b3e0fdac2ded2b0333c2e077e2c41db7a734abab6b082b1a2774`
(Vara mainnet, deployed 28 August 2026 after the end-to-end rehearsal passed)

---

## State right now

| | |
|---|---|
| Spot | **Live and tradeable.** 4 markets, unpaused, verified with a real order |
| Perps | **Closed.** Markets exist but no marks are published, so no position can open |
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
VITE_PROGRAM_ID = 0xf6080c9cdf99b3e0fdac2ded2b0333c2e077e2c41db7a734abab6b082b1a2774
```

and redeploy. Until this is done the live site talks to a retired program.

While there, delete `GROQ_API_KEY`: the endpoint that used it was removed, so there is
no LLM key left in the system.

## 2 · Fund the perps reserve `[you]`

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

> **If the grant is in native VARA rather than wUSDT**, it cannot fund this reserve as
> configured. Two options, and this is a decision rather than a step:
>
> - **Acquire wUSDT** and fund as above. Keeps perps USD-denominated.
> - **Switch collateral to wVARA** (`PerpsV1/SetCollateral`), which native VARA wraps
>   into directly via `VftNativeExchange/Mint`. Margin and PnL would then be
>   denominated in wVARA, so the collateral itself carries VARA price exposure.
>
> Do this before any position is opened. Changing collateral with positions open would
> strand them.

### Sizing it

The per-side open-interest caps are set to 25,000 wUSDT (ETH) and 10,000 wUSDT (VARA).
The contract refuses new positions below **120% coverage** of what the reserve already
owes, so the reserve bounds real capacity. Start well under the caps and raise both
together as volume justifies it.

## 3 · Start the keeper `[you]`

This is what opens perps. Do it **after** the reserve is funded.

In Render, delete the old `thebook-market-runner` service (its script no longer
exists), then create the blueprint service `thebook-perps-keeper` with:

```
KEEPER_SEED  = <the seed for kGgGRKtWP77HbHVoVdZiBeTz8y92c1oh6t774Pnn8MFS9BwiG>
PROGRAM_ID   = 0xf6080c9cdf99b3e0fdac2ded2b0333c2e077e2c41db7a734abab6b082b1a2774
NODE_ADDRESS = wss://rpc.vara.network
```

The keeper key is already set on the contract and already holds 50 VARA for gas. It
has no admin rights, and a single mark update is bounded to a 10% move.

## 4 · Start the solvency monitor `[you]`

```sh
cd frontend
NODE_ADDRESS=wss://rpc.vara.network \
PROGRAM_ID=0xf6080c9cdf99b3e0fdac2ded2b0333c2e077e2c41db7a734abab6b082b1a2774 \
ALERT_WEBHOOK=<somewhere a human is paged> \
node scripts/solvency-monitor.mjs
```

Asserts `balance >= claims + escrow + dust + reserve` per token every 30s, and alerts
on sudden balance drops, thin perp coverage, and unexpected pause changes.

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
