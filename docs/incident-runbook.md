# Incident runbook

Who does what when something goes wrong, and how to tell that it has.
Written for the audit's M-17 finding: monitoring and a response plan both existed
only as intentions.

**Keep this short and current.** A runbook nobody can follow at 3am is decoration.

---

## Live program

**Current:** `0x8ff92cabb35bdeec210f203f3afcb626e2db106a8362ffff4f5b7b344917fac4`
(deployed 28 August 2026, the remediated build)

**Retired:** `0x7c5dbc8a85a8526c3a0c4fe98f0fb286782849c4d130ff28d6b7b30d157c2484`
— carried C-01 `CallAgentService` (an unauthenticated drain path) and a latent C-02.
It held zero in all four tokens for its whole life, so nothing was ever at risk and
nothing needed migrating. **Do not point anything at it again.**

Verified on the current program with `frontend/scripts/audit-probe.mjs` (read-only):

| | Result |
|---|---|
| Legacy `Orderbook` / `Amm` / `Perps` services | Absent — C-01 and C-02 unreachable |
| Markets listed | 4 |
| Paused | no |
| Custodied value | 0 in all four tokens |

Re-check at any time:

```sh
cd frontend
NODE_ADDRESS=wss://rpc.vara.network \
PROGRAM_ID=0x8ff92cabb35bdeec210f203f3afcb626e2db106a8362ffff4f5b7b344917fac4 \
node scripts/audit-probe.mjs
```

Exit code 1 means a legacy attack surface is present — that should never happen on
this program.

---

## Monitoring

Run the solvency monitor continuously against whatever program is live:

```sh
cd frontend
NODE_ADDRESS=wss://rpc.vara.network \
PROGRAM_ID=0x… \
ALERT_WEBHOOK=https://hooks.slack.com/… \
node scripts/solvency-monitor.mjs
```

It checks, every 30s per token:

- **The solvency invariant.** `balanceOf(program) >= escrow + dust + reserve`.
  A breach means the contract has paid out more than it holds. This is the alarm
  that matters; everything else is early warning.
- **Sudden balance drops.** More than `THRESHOLD_PCT` (default 5%) between polls.
- **Perps reserve coverage** below the 120% floor.
- **Pause state changes** nobody initiated.

`ONCE=1` runs a single check and exits non-zero on any alert — use that for a cron
or an uptime check.

Alerting is only as good as its destination. Set `ALERT_WEBHOOK` to somewhere a
human is actually paged, not a channel nobody reads.

---

## Response

### Who

One named on-call operator with the multisig, at all times. Until the multisig is
live (audit H-09), that is whoever holds the admin key — which is itself the
problem, and the reason this row exists.

### Severity 1 — funds are moving that should not be

Symptoms: solvency alert, an unexplained balance drop, a withdrawal you cannot
attribute, or a report from a user.

1. **Pause the venue.** This is the whole reason the pause exists (audit H-08).

   ```sh
   # As admin. Blocks new orders and new positions.
   # Cancel and withdraw stay open by design — a pause must never trap user funds.
   NODE_ADDRESS=wss://rpc.vara.network PROGRAM_ID=0x… \
   node -e "…Spot/SetPaused(true)"
   ```

   Pausing is reversible and cheap. Pause first, diagnose second. The cost of an
   unnecessary pause is an hour of downtime; the cost of a late one is the book.

2. **Put the frontend into maintenance.** Set `VITE_MAINTENANCE=1` in the Vercel
   project and redeploy, or flip it in the dashboard. The app then shows a notice
   instead of the trading UI. This stops new deposits; it does not stop the chain.

3. **Capture evidence before changing anything else.** Block height, the failing
   invariant, recent events (`SpotEvent` / `PerpsEvent`), and the monitor's log.
   Everything on the money path now emits an event (audit M-02) — that is the
   forensic trail.

4. **Decide: contain or migrate.** If the loss path is in the contract, the program
   must be replaced; a pause only buys time. Deploy the fixed build, then tell users
   to withdraw from the old program (which the pause still allows).

5. **Tell users.** Say what happened, what is affected, and what they should do.
   Before you know the cause, say that too.

### Severity 2 — the venue is degraded but funds are safe

Examples: the mark-price keeper is down, an RPC endpoint is failing, the price feed
is stale.

- **Keeper down.** Positions cannot be opened or closed against a stale mark for
  `MARK_MAX_AGE` (100 blocks). After `MARK_EXIT_AGE` (1200 blocks, roughly an hour)
  the contract lets holders close at entry, at zero PnL, with no keeper involved
  (audit H-04). Nobody is trapped; restore the keeper and the market resumes.
  Restart: the Render worker `thebook-perps-keeper`.
- **Price feed stale.** Display and order-sizing only. Nothing settles against it.
- **RPC failing.** Point `NODE_ADDRESS` at another Vara endpoint and redeploy the
  worker; the frontend reads `VITE_NODE_ADDRESS`.

### Severity 3 — a key is compromised

- **Keeper key.** The keeper can only publish marks, bounded to a 10% move per
  update (audit H-04), and has no admin rights. Rotate with `PerpsV1/SetKeeper`
  from admin, then redeploy the worker with the new `KEEPER_SEED`.
- **Sponsor seed** (`/api/voucher`). Remove `SPONSOR_SEED` from Vercel: the endpoint
  goes inert by design and the app falls back to self-paid gas. Then rotate.
- **Admin key.** This is the bad one, and until the multisig exists there is no
  clean recovery — the holder can list, pause, set the keeper and move the reserve.
  Pause, propose a new admin from the compromised key if you still control it
  (`Spot/ProposeAdmin` then `AcceptAdmin` from the new account), and migrate.
  **Standing up the N-of-M multisig is the fix; everything here is mitigation.**

---

## Recovery checklist

- [ ] Cause identified and written down
- [ ] Fix deployed, or the program replaced
- [ ] Solvency invariant asserted green for one full hour
- [ ] Pause lifted (`Spot/SetPaused(false)`)
- [ ] Maintenance flag cleared
- [ ] Users told what happened and what changed
- [ ] A regression test added that fails on the old behaviour

That last one is not optional. The C-03 margin bug shipped inside a passing test
that asserted an error code and never checked a balance (audit M-15). If the
incident cannot be expressed as a failing test, it is not understood yet.
