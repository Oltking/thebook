# Audit remediation tracker

Source: `thebook Security Audit.pdf` — 27 August 2026, commit `22970f4`.
41 findings: 4 critical, 9 high, 15 medium, 13 low. Three criticals were reproduced
against the compiled WASM.

**Status: every finding is addressed in this source. The fixed build has not yet
been redeployed, and the launch gate is not satisfied.**

Legend: `[x]` done · `[U]` needs the operator — a key, a signature, or a dashboard.

---

## What the live program actually looks like

Verified with `frontend/scripts/audit-probe.mjs` (read-only) against
`0x7c5dbc8a…2484` on Vara mainnet:

| | Result |
|---|---|
| `Orderbook` service | **Present.** C-01 `CallAgentService` is callable. |
| `Orderbook/GetTokens` | Four zero addresses — **C-02 is latent**, one `SetToken` from live. |
| wVARA / wETH / wUSDT / wUSDC held | **0 / 0 / 0 / 0** |

**The deployed program is drainable and holds nothing.** That is the whole reason
this is recoverable without loss. It stops being true the moment anyone deposits, so
it must be replaced before it is used — not after.

---

## Phase 0 — Contain

- [x] P0.1 Maintenance kill-switch — `VITE_MAINTENANCE=1` shows a notice instead of
      the app, without tearing down the deployment.
- [x] P0.2 Probe the live program — `scripts/audit-probe.mjs`. Result above.
- [x] P0.3 Withdraw the perps reserve — **not needed: the reserve is 0.** The probe
      confirms the program holds nothing in any of the four tokens.
- [x] P0.4 `/api/voucher` hardened and fails closed. `[U]` Removing `SPONSOR_SEED`
      from Vercel remains the instant kill switch.
- [x] P0.5 Groq key: **the endpoint is deleted.** `/api/agent` and its only caller
      (the Hive's agent brief) were removed, so there is no server-held LLM key left
      to rotate — delete `GROQ_API_KEY` from Vercel rather than rotating it.
- [ ] P0.5 `[U]` **Rotate the sponsor seed.** It sat unencrypted in `frontend/.env`
      on a development machine and in the Vercel dashboard. Verified never committed:
      `.env` is untracked and a full history scan finds no secret values. The exposure
      is local-machine only, not the repository.
- [x] P0.6 Notify holders — **no holders to notify:** zero custodied balance, and
      `Spot/GetPairs` shows markets listed but the books empty.

## Phase 1 — The criticals

- [x] **C-01** `call_agent_service` deleted with its service. No safe version exists:
      any function letting an untrusted caller choose both target and payload hands
      out the contract's signing authority.
- [x] **C-02** `orderbook.rs`, `amm.rs`, `perps.rs` and `DexState` removed entirely.
      `Join`/`SeedHouse` minting and the `Withdraw` path that paid minted balances in
      real tokens are gone. The legacy frontend (Hive, pools, swap, join) and the
      legacy market-runner went with them.
- [x] **C-03** `open_position` validates everything before the escrow `await`; the
      only post-await checks credit the margin back before returning. Adopted as a
      rule and applied across `place_limit`, `market_buy`, `market_sell`,
      `fund_reserve`. Regression test: `perps_rejected_open_returns_the_margin`.
- [x] **C-04** README and docs now state the audit status plainly and the launch gate
      is tracked below. `[U]` The gate itself is Phase 3.
- [x] **H-02** Filled and cancelled orders are removed from state; only resting
      orders count against the cap; matching walks a price-level index rather than
      every order ever placed.
- [x] **H-03** `min_base_out` / `min_quote_out` on the market functions, plus a
      visible tolerance in the UI and the worst-case fill before signing.
- [x] **H-08** Multisig-ready global pause that never blocks `cancel_order` or
      `withdraw`; `relist_pair` makes delisting reversible.

## Phase 2 — Harden

Contracts
- [x] M-02 `SpotEvent` and `PerpsEvent` on every settlement path.
- [x] H-04 Mark updates bounded to 10% per step, keeper-only (admin is no longer an
      implicit keeper), and a keeper-independent exit at entry after `MARK_EXIT_AGE`.
- [x] H-05 `withdraw_reserve` capped by open liability plus an OI buffer; two-step
      `propose_admin` / `accept_admin`.
- [x] M-03 `max_oi` required at `add_market`; funding rate charging the crowded side.
- [x] M-04 `get_reserve_health` exposed; opens refused below a 120% coverage floor.
- [x] M-05 `notional` uses `checked_mul` and returns `Overflow`.
- [x] M-06 Dust tracked per token and sweepable; solvency invariant documented and
      exposed via `get_solvency`.
- [x] M-08 Caps re-checked after the await, on the borrow that inserts.
- [x] M-14 Decimals verified against each token's `VftMetadata` at listing;
      `relist_pair` added; reverse-orientation duplicates rejected.
- [x] L-01 Partial withdraw. L-02 No self-trading. L-03 Market orders no longer
      stored (they never rest). L-04 `set_keeper` rejects zero. L-05 Pagination with
      a `MAX_PAGE` cap. L-07 Liquidator fee topped up from the reserve so it survives
      a gap move. L-08 Maintenance margin raised to 1%.

API
- [x] H-01 Voucher issuance requires a signed challenge, durable per-address / per-IP
      limits and a daily cap, and **fails closed** without the rate-limit store.
- [x] H-06 The unauthenticated `prices.ts` POST branch is deleted; GET maintains the
      cache and history itself.
- [x] M-16 `agent.ts` origin-locked, rate-limited, size-capped, user text fenced as
      data, and the system prompt corrected to real funds on mainnet.
- [x] L-09 Connection cache drops on failure, timeouts on connect and send, correct
      seed detection, failures return real status codes.
- [x] L-10 Unused Redis clients removed; per-instance cache behaviour documented.

Frontend
- [x] H-07 Approves exactly what the order escrows, both sides, with the amount named
      in the copy.
- [x] M-01 `parseUnits` validates (no hex, no exponents, no double points) and an
      error boundary wraps the router.
- [x] M-07 CSP, `frame-ancestors 'none'`, nosniff, referrer policy, HSTS.
- [x] L-11 Trading inputs have real labels, ids and inline validation.
- [x] L-12 History derives from the state being committed, not a stale snapshot.
- [x] L-13 Dead WebSocket cache rule removed.

Quality / infra
- [x] M-15 Suite rewritten around balance and solvency invariants; every rejection
      path asserts the escrow came back.
- [x] M-10 CI tracked again and extended: frontend typecheck/lint/test/build,
      `npm audit`, `cargo-deny`, secret scanning, and a job asserting the deleted
      attack surface stays deleted.
- [x] M-09 `nanoid` pinned to a patched version via a scoped override —
      `npm audit --omit=dev` reports 0. `trie-db`'s future-incompat warning is
      tracked; it arrives through the Gear runtime and cannot be bumped alone.
- [x] H-09 `NODE_ADDRESS` required with no default in every signing script, CLI wins
      over dotfiles; keeper key split from admin; Render worker moved to the mainnet
      keeper.
- [x] M-17 Solvency monitor, drop and coverage alerting, and an incident runbook.
- [x] M-11 Per-trade, daily and confirmation spend limits in the MCP server.
- [x] L-14 `ensureVoucher` retries on a backoff and reports why it failed.

Disclosure
- [x] M-12 Agent system prompt corrected first; README rewritten; DEPLOY and
      skills.md updated.
- [x] M-13 [Terms](terms.md) and [risk disclosure](risk-disclosure.md) published and
      surfaced in-product on both trade views.

## Phase 3 — The launch gate `[U]`

None of these can be done from the repository. All are required before real funds.

- [ ] **Redeploy the fixed build.** Everything above is source-only until this happens.
- [ ] **N-of-M multisig as admin**, via `propose_admin` / `accept_admin`. Split the
      keeper key at the same time.
- [ ] **Independent professional audit** of the reduced program. This remediation is
      not a substitute, and neither was the assessment that prompted it.
- [ ] **Testnet dress rehearsal** of the fixed contract with real VFT tokens.
- [ ] **At least one committed market maker.** Empty books are what make thin-book
      attacks worth attempting, even with slippage bounds in place.
- [ ] Rotate the sponsor seed, and delete `GROQ_API_KEY` from Vercel (P0.5).
- [ ] Run the solvency monitor against the new program before opening deposits.

---

## Verification

```
cargo fmt -- --check                 clean
cargo clippy --all-targets -D warnings  clean (one tracked trie-db future-incompat note)
cargo test -p thebook-app --lib      14 passed   (was 4)
cargo test --test gtest              26 passed   (balance + solvency invariants)
cd frontend && npx tsc -b            clean
cd frontend && npx eslint .          clean
cd frontend && npx vitest run        26 passed   (was 10)
cd frontend && npm audit --omit=dev  0 vulnerabilities
cd frontend && npm run build         ok
```
