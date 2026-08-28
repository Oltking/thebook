# Audit remediation tracker

Source: `thebook Security Audit.pdf` — 27 August 2026, commit `22970f4`.
41 findings: 4 critical, 9 high, 15 medium, 13 low. Three criticals were reproduced
against the compiled WASM.

Status legend: `[ ]` todo · `[x]` done · `[~]` partially done · `[U]` needs the operator
(a key, a signature, or a dashboard I cannot and should not touch).

---

## Phase 0 — Contain (hours, not sprints)

- [ ] P0.1 Maintenance kill-switch in the frontend, so the app can be taken out of
      service without a redeploy of the contract. Env-flag gated.
- [ ] P0.2 Read-only probe: does `Orderbook/GetTokens` return four zero addresses on
      the live program? Determines whether C-02 is live or latent.
- [ ] P0.3 `[U]` Withdraw the perps reserve to a safe account. Script prepared here;
      the operator signs it.
- [ ] P0.4 Disable `/api/voucher`. Endpoint made inert in code; `[U]` operator removes
      `SPONSOR_SEED` from Vercel.
- [ ] P0.5 `[U]` Rotate the Groq key and the sponsor seed.
- [ ] P0.6 `[U]` Notify anyone holding a claim balance or an open position.

## Phase 1 — Fix the criticals

- [ ] C-01 Delete `call_agent_service` (`orderbook.rs:835`). Unauthenticated arbitrary
      cross-program call = the contract's signing authority handed to any caller.
- [ ] C-02 Remove `orderbook.rs`, `amm.rs`, `perps.rs`, and `DexState` from the program.
      Deletes `Join`/`SeedHouse` minting and the `Withdraw` path that converts minted
      virtual balance into real tokens. Also retires the legacy frontend views and the
      legacy market-runner that depend on them.
- [ ] C-03 Move every validation in `open_position` before the escrow `await`; adopt the
      credit-and-return rule so a post-await rejection can never keep a user's margin.
- [ ] H-08 Multisig-gated global pause. Blocks placing orders and opening positions;
      `cancel_order` and `withdraw` stay open so a pause never traps funds.
- [ ] H-02 Prune filled/cancelled orders; count only resting orders against the cap;
      replace the flat vector scan with a price-level index.
- [ ] H-03 Slippage bounds: `min_quote_out` on `market_sell`, `min_base_out` on
      `market_buy`, plus a visible tolerance in the UI.

## Phase 2 — Harden (before redeploy)

Contracts
- [ ] M-02 `SpotEvent` / perps events on every settlement path.
- [ ] H-04 Mark-price deviation bound, staleness-based keeper-independent exit.
- [ ] H-05 Cap `withdraw_reserve` against open liability; two-step `transfer_admin`.
- [ ] M-03 `max_oi` required at `add_market`, no unlimited default.
- [ ] M-05 `notional` uses `checked_mul`, not `saturating_mul`.
- [ ] M-06 Track rounding dust in a counter; document the solvency invariant.
- [ ] M-08 Re-check state caps after the await, on the same borrow that pushes.
- [ ] M-14 Verify decimals on-chain at listing; add `relist_pair`; reject reverse-
      orientation duplicates.
- [ ] L-01 Partial withdraw (amount argument).
- [ ] L-02 Exclude the caller's own resting orders from crossing (no self-trade).
- [ ] L-03 Market orders stored with `price: 0` render as zero in history.
- [ ] L-04 `set_keeper` rejects the zero address.
- [ ] L-05 Paginate `get_positions`, `get_pairs`, `get_my_orders`.
- [ ] L-07 Liquidation reward not capped to vanishing residual equity.
- [ ] L-08 Raise maintenance margin relative to max leverage.

API
- [ ] H-01 Voucher: signed challenge, durable rate limit, daily cap, origin lock — or
      delete, per MAINNET.md.
- [ ] H-06 Delete the `prices.ts` POST branch.
- [ ] M-16 `agent.ts`: origin lock, rate limit, size cap, user strings as delimited data,
      corrected system prompt.
- [ ] L-09 Voucher handler robustness (connection reuse, timeout, seed detection, status
      codes).
- [ ] L-10 Remove unused Redis deps; document per-instance cache behaviour.

Frontend
- [ ] H-07 Approve exactly what the order needs; no unlimited allowance behind a
      "this order only" label.
- [ ] M-01 Validate `parseUnits` input; add an error boundary around the router.
- [ ] M-07 Security headers in `vercel.json` (CSP, `frame-ancestors 'none'`, nosniff,
      referrer policy).
- [ ] L-11 Label the trading inputs for screen readers.
- [ ] L-12 Finish the half-applied `MarketDataProvider` fix (`appendHistory` stale
      snapshot).
- [ ] L-13 Remove the dead WebSocket PWA cache rule.

Quality / infra
- [ ] M-15 Assert balance invariants on every rejection path; solvency invariant per
      test; state-growth test; test `units.ts`.
- [ ] M-10 Restore CI to tracking and extend it (tsc, eslint, vitest, npm audit,
      cargo deny, secret scanning).
- [ ] M-09 Resolve the `nanoid` advisory reaching production.
- [ ] H-09 `NODE_ADDRESS` required with no default in every signing script; CLI-wins
      guard everywhere; keeper key split from admin.
- [ ] M-17 Solvency monitor, withdrawal alerting, incident runbook.
- [ ] M-11 Per-trade and per-day caps in the MCP server; human-readable echo and
      confirmation; reverse the "approve a large amount" guidance.
- [ ] L-14 `ensureVoucher` retries and signals failure instead of silently swallowing.

Disclosure
- [ ] M-12 Correct the agent system prompt first, then README, DEPLOY, skills.md.
- [ ] M-13 Terms, risk disclosure, jurisdiction statement.

## Phase 3 — Satisfy the launch gate `[U]`

- [ ] H-09 Stand up the N-of-M multisig; transfer admin to it.
- [ ] C-04 Independent professional audit of the reduced program.
- [ ] Testnet dress rehearsal with real VFT tokens.
- [ ] At least one committed market maker.
