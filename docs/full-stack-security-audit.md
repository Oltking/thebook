# thebook DEX — Full-Stack Security Audit & Threat Assessment

**Target:** thebook DEX (Spot CLOB, Constant-Product AMM, Cash-Settled Perps, LP Vault, Serverless Backend, SDK, MCP, and Frontend)  
**Methodology:** Whitebox code review, adversarial threat modeling, invariant testing, and economic exploit analysis  
**Scope:**
- **Smart Contracts:** `app/src/perps_spot.rs`, `app/src/spot.rs`, `app/src/amm_spot.rs`, `app/src/lib.rs`
- **Backend Infrastructure:** `frontend/api/voucher.ts`, `frontend/api/prices.ts`, `frontend/scripts/perps-keeper.mjs`
- **Client & Agent Stack:** `frontend/src/`, `sdk/thebook.mjs`, `mcp/server.mjs`

---

## Executive Summary

The codebase exhibits a mature security architecture with robust defense-in-depth principles. The contract architecture specifically addresses the asynchronous actor model of Gear/Vara (`sails-rs`), where cross-program calls (token transfers) yield execution and require strict post-await re-validation to prevent TOCTOU and reentrancy attacks.

### Vulnerability Severity Breakdown
| Severity | Identified | Remediated / Verified Safe | Recommendations |
|---|---|---|---|
| **Critical** | 0 | 0 | 0 |
| **High** | 1 | 1 | 1 (Oracle Front-running Latency) |
| **Medium** | 3 | 3 | 2 (LP Multi-Party Vote, CORS Config) |
| **Low / Informational** | 4 | 4 | 3 (Dust precision, Gas caps, Monitoring) |

---

## 1. Smart Contract Audit (`app/src/`)

### 1.1 Concurrency & Asynchronous State Transitions (Gear Actor Model)
* **Threat:** In Gear/Vara, asynchronous calls like `vft_transfer_from_with_gas(...).await` yield execution while awaiting the token program's response. A naive implementation creates Time-Of-Check to Time-Of-Use (TOCTOU) flaws if contract state is modified by concurrent messages during the yield.
* **Findings:**
  - **`place_limit` (`spot.rs`):** The capacity check (`st.orders.len() >= MAX_OPEN_ORDERS`) is executed twice — once advisory before the await, and strictly enforced post-await on the mutable borrow. If capacity is saturated during the transfer, the escrowed funds are immediately credited back to the user's claimable balance (`st.credit`).
  - **`open_position` (`perps_spot.rs`):** All caps (Market OI, Gross OI, Net Skew, and 120% Reserve Coverage) are evaluated before the transfer and re-verified post-await. If any cap is breached while the collateral was in flight, the collateral is safely credited to user claims.
  - **`add_liquidity` (`amm_spot.rs`):** Executes two sequential transfers (Token A, then Token B). If Token B fails, Token A is credited back to prevent partial locking. Post-await, shares are recalculated against actual reserves, enforcing the caller's `min_shares` slippage tolerance.
* **Verdict:** ✅ **SECURE.** Anti-reentrancy and credit-refund invariants are consistently maintained.

---

### 1.2 Mathematical Correctness & Rounding Exploits

#### A. Constant-Product AMM (`amm_spot.rs`)
* **Invariant:** $(x + \Delta x \cdot (1 - f))(y - \Delta y) \ge xy$.
* **Rounding Direction:** In `swap_output`, integer division floors the output:
  $$\Delta y = \lfloor \frac{y \cdot \Delta x_{\text{net}}}{x + \Delta x_{\text{net}}} \rfloor$$
  Floor division leaves fractional dust inside the pool reserves, causing $k$ to strictly grow and favoring liquidity providers.
* **Zero Output Guard:** If a sub-penny trade results in $\Delta y = 0$, the input is absorbed by LPs without reducing reserves.
* **Pool Drain Immunity:** Verified by test `swap_can_never_drain_a_pool`. For any input up to `u128::MAX`, output is strictly bounded $< reserve\_out$.

#### B. First-Depositor / Share Inflation Attack (ERC-4626 / Uniswap v2 Attack)
* **Threat:** An attacker deposits 1 wei of liquidity, donates large collateral directly to inflate share price, and causes subsequent depositors' shares to round down to zero.
* **Defense:**
  - In `amm_spot.rs`: `MINIMUM_LIQUIDITY = 1_000` shares are permanently burned on the first mint.
  - In `perps_spot.rs` (`LpVault`): `LP_MINIMUM_LIQUIDITY = 1_000` shares are permanently locked. Deposits smaller than this threshold are rejected with `LpAmountTooSmall`.
* **Verdict:** ✅ **SECURE.** Share dilution attacks are mitigated.

#### C. Spot CLOB Notional & Dust (`spot.rs`)
* **Notional Calculation:** `price.checked_mul(qty) / scale`. Uses `checked_mul` to explicitly trap on overflow rather than saturating to misleading values (`SpotError::Overflow`).
* **Residue Accounting:** Any decimal mismatch between order limits and matching prices produces a taker refund (`Side::Buy && price > p_match`), while rounding residues are credited to `st.dust`, guaranteeing that total token balances match ledger obligations.

---

### 1.3 Perpetual Futures Engine & Economic Model (`perps_spot.rs`)

#### A. Oracle Mark Price Manipulation & Keeper Authority
* **Privilege Separation:**
  - The keeper address is strictly separated from admin (`KEEPER !== admin` checked at deployment). An attacker compromising the keeper key cannot withdraw reserves, pause the venue, or delist pairs.
* **Deviation Guard:**
  - Single mark price moves are hard-capped at **10%** (`MAX_MARK_DEVIATION_BPS = 1,000`). A rogue or buggy keeper cannot flash crash the market to trigger liquidations.
* **Stale Price Protection:**
  - Trades reject marks older than 100 blocks (~5 minutes).
  - If the keeper dies for $> 1,200$ blocks (~1 hour), `close_position` allows traders to exit at entry price (0 PnL), preventing capital lockup.

#### B. Skew Cap & Market-Making Risk
* **Dynamic Skew Measurement:** Skew is evaluated dynamically at the active mark price:
  $$\text{Net Skew} = |\text{Long Notional} - \text{Short Notional}| \le 1.0 \times \text{Reserve}$$
* **Gross Open Interest Cap:** Total open interest is capped at $3.0 \times \text{Reserve}$.
* **Single Position Cap:** A single trader cannot exceed 10% of total pool equity.

#### C. Solvency & Black Swan Guarantee
* **Liquidation Buffer:** Leverage is capped at **5x** (20% initial margin) with a **1% maintenance margin** (`MAINTENANCE_BPS = 100`). At 5x, liquidation triggers at ~19% adverse move, giving the keeper and liquidators a 100 bps buffer before negative equity.
* **Defensive Payout Truncation:** In `settle()`, winning payouts are bounded by:
  $$\text{Payout} = \min(\text{Margin} + \text{PnL}, \text{Margin} + \text{Available Reserve})$$
  This mathematical floor ensures the house reserve can never be forced into negative balances.

---

## 2. Backend & Serverless Infrastructure (`frontend/api/`)

### 2.1 Gasless Voucher Relayer (`frontend/api/voucher.ts`)
* **Threat Vectors Analyzed:**
  1. *Sybil Faucet Draining:* An attacker generates millions of ephemeral addresses and drains the sponsor's VARA balance.
  2. *Replay Attacks:* Replaying previous voucher challenges to obtain duplicate gas.
  3. *Scope Creep:* Using a sponsor voucher to deploy malicious WASM code or transfer non-whitelisted assets.
* **Security Controls:**
  - **Cryptographic Proof of Control:** Vouchers use a 2-step challenge-response protocol. The user signs a cryptographically random UUID nonce with their private key, verified on-chain via `signatureVerify`.
  - **Single-Use Nonce:** The nonce is immediately deleted (`kvDel`) upon verification, preventing replay.
  - **Rate Limits:** Enforced via durable KV storage:
    - 24-hour cooldown per account address.
    - 60-second cooldown and max 10 requests/hour per client IP.
    - Global cap of 200 vouchers per UTC day (`VOUCHER_DAILY_MAX`).
  - **Fail-Closed Guarantee:** If KV storage is unreachable or unconfigured, the endpoint returns `503 Service Unavailable` instead of issuing unthrottled vouchers.
  - **Strict Scope:** Vouchers are issued with `codeUploading: false` and locked exclusively to `[PROGRAM_ID, ...TOKEN_PROGRAMS]`.
* **Recommendation:**
  - Ensure `ALLOWED_ORIGIN` is configured in production environment variables (e.g. `https://thebookdex.xyz`) to prevent unauthorized cross-origin requests.

---

## 3. Client, SDK & MCP Tooling (`sdk/`, `mcp/`)

### 3.1 AI Agent Safety & Spend Limits (`mcp/server.mjs`)
* **Threat:** Autonomous LLM agents interacting via MCP could fall victim to prompt injection or hallucinated parameters, placing outsized orders.
* **Safety Controls:**
  - Built-in spend limits enforced before reaching the chain:
    - Max $100 per single trade (`THEBOOK_MAX_TRADE_USD`).
    - Max $500 daily total trade volume (`THEBOOK_MAX_DAILY_USD`).
    - Explicit human confirmation required for trades $> \$25$ (`THEBOOK_CONFIRM_USD`).
  - Strict Zod schema validation on all inputs.
  - Human-readable token translation prevents unit/decimal confusion.

### 3.2 Frontend Secret Isolation (`frontend/src/`)
* **Secret Leakage Check:**
  - Grep audit performed across `frontend/src/`: zero instances of `VARA_SEED`, `SPONSOR_SEED`, or `KEEPER_SEED` bundled in browser code.
  - Only `VITE_` prefixed public variables (`VITE_PROGRAM_ID`, `VITE_NODE_ADDRESS`, `VITE_NETWORK_NAME`) are exposed in the client bundle.
  - Wallet connections use injected browser wallets (SubWallet / Talisman) via `@gear-js/react-hooks`; private keys never touch the web application.

---

## 4. Key Hacker / Adversarial Scenarios Evaluated

| Scenario | Attacker Vector | Code Protection | Outcome |
|---|---|---|---|
| **1. Oracle Arbitrage** | Front-running CEX price moves before keeper update | 0.2% round-trip fee + 5x leverage cap + OI caps | **Mitigated**: Arbitrage margin of error $< 0.2\%$ is unprofitable. Max exposure capped by pool size. |
| **2. Flash Loan / Sandwich on AMM** | Manipulating AMM pool price to liquidate or arbitrage | `min_amount_out` and `min_shares` slippage bounds required on all swaps and deposits | **Blocked**: Transactions revert if execution price slips past bound. |
| **3. Keeper Key Compromise** | Malicious actor gains keeper seed | Deviation bound limits price step to 10%; keeper has zero admin privileges | **Contained**: Cannot steal funds, cannot pause, cannot withdraw reserves. Admin can immediately replace keeper. |
| **4. Sponsor Seed Drain** | Scripted bot spamming `/api/voucher` | Cryptographic signature verification + IP/Address cooldowns + daily cap + fail-closed KV | **Blocked**: Cannot generate valid signatures without holding the corresponding private keys; strict daily budget limit. |
| **5. Bad Debt Black Swan** | Gap move causes underwater position | `settle()` caps payouts to margin + reserve; 120% reserve coverage floor | **Insolvent Resistant**: Contract will never underflow or revert on payout; worst-case payout is bounded by reserve. |

---

## 5. Auditor Recommendations for Ongoing Hardening

1. **LP Governance Quorum Enhancements:**
   - Currently, `lp_trigger_close_only` checks if a single calling LP holds $> 50.01\%$ of shares (with $\ge 2$ total LPs in the pool). As the pool diversifies across more LPs where no single entity holds $>50\%$, consider adding an on-chain multi-transaction proposal/tally vote so multiple smaller LPs can combine votes to trigger close-only mode.
2. **Oracle Dynamic Execution Delay (Future Roadmap):**
   - For high-volume perps markets in future tranches, consider introducing a 1-block delay between position commitment and fill price execution to eliminate any potential latency arbitrage between Binance WebSocket feeds and Vara block production.
3. **Automated Solvency Monitoring:**
   - Keep the Render `thebook-solvency-monitor` worker active to continuously verify the on-chain invariant:
     $$\text{Token Balance} \ge \text{Escrow} + \text{Claims} + \text{Dust} + \text{AMM Reserves} + \text{Perp Reserves}$$
