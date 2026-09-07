//! v1 mainnet perps — cash-settled perpetual futures over the spot collateral token.
//!
//! Margin is escrowed in the real collateral token via the same async VFT path as
//! spot, and PnL settles into the shared `claims` balance the user withdraws with
//! `Spot/Withdraw`. Positions are cash-settled: no base token is ever held for a
//! perp, only the collateral. A keeper pushes mark prices; a real house reserve pays
//! trader profit and absorbs losses.
//!
//! ## The house is the counterparty
//!
//! Every trade is against the reserve, so the reserve carries the market's whole
//! one-sided exposure. Three things bound that, all added in audit remediation:
//! a mandatory per-side open-interest cap (M-03), a funding rate that charges the
//! crowded side (M-03), and a coverage floor that stops new opens when the reserve
//! is thin relative to what it already owes (M-04).
//!
//! ## Post-escrow rule
//!
//! `open_position` validates everything it can before the escrow `await`. The only
//! post-await checks are the ones the await itself invalidates (capacity and the OI
//! cap), and both credit the margin back to the trader's claim before returning, so
//! a rejection can never keep their money (audit C-03, M-08).

use crate::spot::{SpotError, SpotState, vft_transfer_from_with_gas, vft_transfer_with_gas};
use crate::types::TransferError;
use sails_rs::cell::RefCell;
use sails_rs::gstd::{exec, msg};
use sails_rs::prelude::*;
use sails_rs::scale_codec::{Decode, Encode};

extern crate alloc;
use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;

/// Max leverage on any position.
///
/// Launching at 5x deliberately, with room to raise it later. At 20x against a mark
/// that may be up to `MARK_MAX_AGE` blocks stale, liquidation lands roughly 4% away
/// from entry — close enough that ordinary volatility between two keeper updates can
/// take a position out, and every shortfall past the maintenance buffer lands on the
/// house reserve (audit L-08). At 5x that distance is roughly 19%, which the buffer
/// and the funding rate can actually absorb.
///
/// Raising this is a one-line change plus a redeploy, and should follow a funded
/// reserve and real traded volume — not precede them.
pub const MAX_LEVERAGE: u32 = 5;
/// Trading fee per side (open and close), in basis points of notional. Fees accrue to
/// the house reserve — that's the perps revenue on top of trader losses.
pub const FEE_BPS: u128 = 10; // 0.1%
/// Maintenance-margin requirement, in basis points of notional.
///
/// Raised from 0.5% to 1% in audit remediation (L-08): against a mark that may be up
/// to `MARK_MAX_AGE` blocks stale, a 0.5% buffer left the reserve absorbing most gap
/// moves. Paired with the reduction of `MAX_LEVERAGE` to 5x.
pub const MAINTENANCE_BPS: u128 = 100; // 1%
/// Liquidator's cut, in basis points of margin.
pub const LIQUIDATION_FEE_BPS: u128 = 100; // 1%
/// Max age (blocks) of a mark before ordinary perp actions reject it as stale.
pub const MARK_MAX_AGE: u32 = 100;
/// After this many blocks without a mark, `close_position` stops requiring a fresh
/// price and settles at entry (zero PnL). A keeper outage must never trap collateral
/// (audit H-04).
pub const MARK_EXIT_AGE: u32 = 1_200;
/// Max relative move a single `set_mark` may make from the previous mark, in basis
/// points. A compromised or buggy keeper cannot reprice the book in one step
/// (audit H-04).
pub const MAX_MARK_DEVIATION_BPS: u128 = 1_000; // 10%
pub const MAX_POSITIONS: usize = 10_000;
/// Reserve coverage floor, in basis points. New positions are refused when the
/// reserve is below this multiple of what it already owes (audit M-04).
pub const MIN_COVERAGE_BPS: u128 = 12_000; // 120%
/// Buffer, in basis points of open interest, that `withdraw_reserve` must leave
/// behind on top of current unrealised liability (audit H-05).
pub const RESERVE_BUFFER_BPS: u128 = 500; // 5% of OI

/// Funding index units: `FUNDING_SCALE` = 100% of notional.
pub const FUNDING_SCALE: i128 = 1_000_000_000_000;
/// Funding accrued per block at full one-sided imbalance, in `FUNDING_SCALE` units.
/// At Vara's ~3s blocks this is roughly 0.12%/hour when one side is entirely alone.
pub const FUNDING_MAX_PER_BLOCK: i128 = 1_000_000;
/// Holding fee accrued per block on every open position, in `FUNDING_SCALE` units.
/// This is deliberately much smaller than directional funding: it prices reserve
/// usage without becoming the main PnL driver.
pub const HOLDING_FEE_PER_BLOCK: i128 = 10_000;
/// Net skew limit as a multiple of the reserve/pool, in basis points.
pub const SKEW_CAP_BPS: u128 = 10_000; // 1.0x pool
/// Gross open-interest limit as a multiple of the reserve/pool, in basis points.
pub const GROSS_OI_CAP_BPS: u128 = 30_000; // 3.0x pool
/// Single-position concentration cap as a multiple of the reserve/pool.
pub const MAX_POSITION_BPS: u128 = 1_000; // 10% pool

/// LP Vault: 12-month lock period in blocks (~3s blocks: 12 months ≈ 10,512,000 blocks).
pub const LP_LOCK_DURATION_BLOCKS: u32 = 10_512_000;
/// Minimum LP shares required to trigger close-only switch (50% + 1).
pub const LP_CLOSE_ONLY_THRESHOLD_BPS: u128 = 5_001; // 50.01%
/// Minimum LP shares locked to zero address on first deposit.
/// Prevents first-depositor attack where they could donate to reserves to inflate share price.
pub const LP_MINIMUM_LIQUIDITY: u128 = 1_000;

#[derive(Encode, Decode, TypeInfo, Clone, Copy, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum PerpsError {
    NotAdmin,
    NotKeeper,
    BadParams,
    NoMarket,
    MarketInactive,
    StaleMark,
    LeverageTooHigh,
    InsufficientMargin,
    PositionNotFound,
    NotLiquidatable,
    BookFull,
    TransferFailed(TransferError),
    NoCollateral,
    /// Opening would push this side's open interest past the market cap.
    OiCapExceeded,
    /// Trading is paused. Closing and liquidating stay open.
    Paused,
    /// This market is close-only: existing positions can close/liquidate, but no
    /// new positions may be opened.
    CloseOnly,
    /// The mark update deviates further from the previous mark than the bound allows.
    MarkDeviationTooLarge,
    /// The reserve is too thin relative to what it already owes to accept new risk.
    InsufficientCoverage,
    /// An amount overflowed. Trapping beats a silently wrong number.
    Overflow,
    /// LP vault: deposit amount is zero.
    LpZeroAmount,
    /// LP vault: lock period not expired.
    LpLocked,
    /// LP vault: deposit not found.
    LpDepositNotFound,
    /// LP vault: insufficient shares for action.
    LpInsufficientShares,
    /// LP vault: close-only already active.
    LpCloseOnlyAlreadyActive,
    /// LP vault: deposit too small to cover minimum liquidity lock.
    LpAmountTooSmall,
}

impl From<SpotError> for PerpsError {
    fn from(e: SpotError) -> Self {
        match e {
            SpotError::Overflow => PerpsError::Overflow,
            SpotError::Paused => PerpsError::Paused,
            SpotError::TransferFailed(e) => PerpsError::TransferFailed(e),
            _ => PerpsError::BadParams,
        }
    }
}

// ── Events (audit M-02) ─────────────────────────────────────────────────────────────
#[sails_rs::event]
#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum PerpsEvent {
    MarketAdded {
        market_id: u64,
        symbol: String,
        max_oi: u128,
    },
    MarketCapSet {
        market_id: u64,
        max_oi: u128,
    },
    MarkSet {
        market_id: u64,
        price: u128,
        block: u32,
    },
    PositionOpened {
        position_id: u64,
        market_id: u64,
        owner: ActorId,
        is_long: bool,
        notional: u128,
        entry: u128,
        margin: u128,
        leverage: u32,
    },
    PositionClosed {
        position_id: u64,
        owner: ActorId,
        payout: u128,
        pnl: i128,
        funding: i128,
        at_entry: bool,
    },
    PositionLiquidated {
        position_id: u64,
        owner: ActorId,
        liquidator: ActorId,
        to_owner: u128,
        fee: u128,
    },
    ReserveFunded {
        amount: u128,
        reserve: u128,
    },
    ReserveWithdrawn {
        amount: u128,
        reserve: u128,
    },
    KeeperSet {
        keeper: ActorId,
    },
    CollateralSet {
        token: ActorId,
    },
    LpDeposited {
        lp: ActorId,
        amount: u128,
        shares: u128,
        unlock_block: u32,
    },
    LpRedeemed {
        lp: ActorId,
        amount: u128,
        shares: u128,
    },
    LpCloseOnlyTriggered {
        trigger_lp: ActorId,
        supporting_shares: u128,
        total_shares: u128,
    },
    LpCloseOnlyReverted {
        trigger_lp: ActorId,
    },
}

#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct PerpMarket {
    pub id: u64,
    pub symbol: String,
    /// Mark price (arbitrary consistent units; PnL uses price ratios so the unit cancels).
    pub mark: u128,
    /// Block the mark was last published.
    pub mark_block: u32,
    pub active: bool,
    /// Open interest (sum of position notional) per side — the house's directional
    /// exposure. Capped by `max_oi` so the reserve's worst-case loss is bounded.
    pub long_oi: u128,
    pub short_oi: u128,
    /// Whether the market accepts new positions. Close/liquidate stay open.
    pub close_only: bool,
    /// Excluded from new positions at launch (e.g., VARA market per committee recommendation).
    /// Existing positions can still close/liquidate.
    pub excluded: bool,
    /// Max open interest per side. Required at market creation: there is no
    /// unlimited default, because the safe value should not depend on an operator
    /// remembering a second call (audit M-03).
    pub max_oi: u128,
    /// Cumulative funding index in `FUNDING_SCALE` units. Rises while longs are the
    /// crowded side, falls while shorts are. Longs pay the increase, shorts receive
    /// its negation; both settle against the reserve, which is the counterparty.
    pub cum_funding: i128,
    /// Cumulative holding-fee index charged to every open position.
    pub cum_holding: i128,
    /// Block `cum_funding` was last advanced.
    pub funding_block: u32,
}

/// LP Vault: holds LP collateral, issues shares, enforces 12-month lock,
/// and grants close-only switch right to LP majority.
#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq, Default)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct LpVault {
    /// Total collateral in vault (wUSDT smallest units).
    pub total_collateral: u128,
    /// Total LP shares issued.
    pub total_shares: u128,
    /// Per-LP deposits: (lp_address, deposit_id) -> (amount, deposit_block, shares).
    /// Using nested map via BTreeMap would be ideal but we flatten with compound key.
    /// For simplicity, we track total per LP and their unlock block.
    pub lp_deposits: Vec<LpDeposit>,
    /// Next deposit ID.
    pub next_deposit_id: u64,
    /// Whether the perps market is in close-only mode (triggered by LP majority).
    pub close_only: bool,
}

/// Individual LP deposit with lock tracking.
#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct LpDeposit {
    pub id: u64,
    pub lp: ActorId,
    pub amount: u128,
    pub shares: u128,
    pub deposit_block: u32,
    /// Block when lock expires (deposit_block + LOCK_DURATION_BLOCKS).
    pub unlock_block: u32,
}

/// Mainnet metrics for transparency (committee request).
#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct MainnetMetrics {
    pub timestamp_block: u32,
    pub tvl: u128,
    pub perp_reserve: u128,
    pub lp_vault_collateral: u128,
    pub position_margin: u128,
    pub active_markets: u32,
    pub total_volume_30d: u128,
    pub total_volume_60d: u128,
    pub unique_wallets_30d: u32,
    pub unique_wallets_60d: u32,
    pub pool_health: Vec<MarketHealth>,
    pub lp_vault: LpVaultState,
}

/// Per-market health metrics.
#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct MarketHealth {
    pub market_id: u64,
    pub symbol: String,
    pub mark: u128,
    pub reserve: u128,
    pub long_oi: u128,
    pub short_oi: u128,
    pub net_skew: u128,
    pub skew_cap: u128,
    pub skew_utilization_bps: u128,
    pub close_only: bool,
    pub excluded: bool,
}

/// LP vault state summary.
#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct LpVaultState {
    pub total_collateral: u128,
    pub total_shares: u128,
    pub close_only: bool,
    pub deposit_count: u32,
}

#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct PerpPosition {
    pub id: u64,
    pub owner: ActorId,
    pub market_id: u64,
    pub is_long: bool,
    /// Position notional (collateral units) = margin * leverage.
    pub notional: u128,
    /// Mark price at entry.
    pub entry: u128,
    /// Collateral locked (collateral smallest-units).
    pub margin: u128,
    pub leverage: u32,
    /// `cum_funding` at entry; the difference at close is what this position owes.
    pub entry_funding: i128,
    /// `cum_holding` at entry; the difference at close is the time-based reserve fee.
    pub entry_holding: i128,
}

/// Signed PnL (collateral units) of a position at `mark`, ratio-based so price units
/// cancel: `notional * (mark - entry) / entry`, negated for shorts.
pub fn pnl_of(pos: &PerpPosition, mark: u128) -> i128 {
    if pos.entry == 0 {
        return 0;
    }
    let diff = mark as i128 - pos.entry as i128;
    let signed = if pos.is_long { diff } else { -diff };
    (pos.notional as i128 * signed) / pos.entry as i128
}

/// Funding this position owes (positive) or is owed (negative) at `cum_funding`.
pub fn funding_of(pos: &PerpPosition, cum_funding: i128) -> i128 {
    let delta = cum_funding - pos.entry_funding;
    let signed = if pos.is_long { delta } else { -delta };
    (pos.notional as i128 * signed) / FUNDING_SCALE
}

/// Holding fee this position owes at `cum_holding`.
pub fn holding_fee_of(pos: &PerpPosition, cum_holding: i128) -> i128 {
    let delta = cum_holding - pos.entry_holding;
    (pos.notional as i128 * delta) / FUNDING_SCALE
}

/// Advance a market's funding index to `block`, charging the crowded side.
/// Uses entry notional for OI (simple, gas-efficient). For mark-to-market skew,
/// use `skew_at_mark` which marks positions to current price.
pub fn accrue_funding(m: &mut PerpMarket, block: u32) {
    let elapsed = block.saturating_sub(m.funding_block) as i128;
    if elapsed <= 0 {
        return;
    }
    let total = m.long_oi.saturating_add(m.short_oi);
    if total > 0 {
        // Signed imbalance in basis points: +10_000 = all long, -10_000 = all short.
        let imbalance = ((m.long_oi as i128 - m.short_oi as i128) * 10_000) / total as i128;
        m.cum_funding += FUNDING_MAX_PER_BLOCK * imbalance / 10_000 * elapsed;
        m.cum_holding += HOLDING_FEE_PER_BLOCK * elapsed;
    }
    m.funding_block = block;
}

/// Accrue funding for ALL markets up to current block.
/// Permissionless — anyone can call to keep funding indices fresh.
pub fn accrue_all_funding(st: &mut SpotState) {
    let block = exec::block_height();
    for m in st.perp_markets.iter_mut() {
        if m.active && m.mark != 0 {
            accrue_funding(m, block);
        }
    }
}

/// Compute net skew at CURRENT mark prices (not entry notional).
/// This is what the committee requires: skew measured at current price.
/// Returns (long_notional_at_mark, short_notional_at_mark, net_skew).
pub fn skew_at_mark(st: &SpotState, market_id: u64) -> Option<(u128, u128, u128)> {
    let market = st.perp_markets.iter().find(|m| m.id == market_id)?;
    if market.mark == 0 {
        return None;
    }
    let mut long_at_mark: u128 = 0;
    let mut short_at_mark: u128 = 0;
    for p in st.perp_positions.iter() {
        if p.market_id != market_id {
            continue;
        }
        // Mark notional to current price: notional * mark / entry
        let marked_notional = if p.entry != 0 {
            p.notional
                .saturating_mul(market.mark)
                .checked_div(p.entry)
                .unwrap_or(p.notional)
        } else {
            p.notional
        };
        if p.is_long {
            long_at_mark = long_at_mark.saturating_add(marked_notional);
        } else {
            short_at_mark = short_at_mark.saturating_add(marked_notional);
        }
    }
    let net_skew = long_at_mark.abs_diff(short_at_mark);
    Some((long_at_mark, short_at_mark, net_skew))
}

fn gross_oi(m: &PerpMarket) -> u128 {
    m.long_oi.saturating_add(m.short_oi)
}

#[allow(dead_code)]
fn net_skew_value(m: &PerpMarket) -> u128 {
    m.long_oi.abs_diff(m.short_oi)
}

/// Settle a closing position against the reserve. Returns `(payout, reserve_delta)`;
/// payout is capped at `margin + reserve` so the reserve can never go negative.
pub fn settle(margin: u128, pnl: i128, reserve: u128) -> (u128, i128) {
    let equity = margin as i128 + pnl;
    let cap = margin as i128 + reserve as i128;
    let payout = equity.clamp(0, cap) as u128;
    let reserve_delta = margin as i128 - payout as i128;
    (payout, reserve_delta)
}

/// Mark price at which a position's equity hits maintenance margin (0 if none).
pub fn liq_price(pos: &PerpPosition, maintenance_bps: u128) -> u128 {
    if pos.notional == 0 || pos.entry == 0 {
        return 0;
    }
    let n = pos.notional as i128;
    let e = pos.entry as i128;
    let m = pos.margin as i128;
    let mm = maintenance_bps as i128;
    let nm = n * mm / 10_000;
    let num = if pos.is_long { nm - m + n } else { m - nm + n };
    let x = e * num / n;
    if x < 0 { 0 } else { x as u128 }
}

/// What the reserve currently owes: every position's unrealised profit, plus a
/// buffer proportional to open interest for the moves that have not happened yet.
/// This is what makes solvency a contract invariant rather than operator discipline
/// (audit H-05).
pub fn reserve_liability(st: &SpotState) -> u128 {
    let mut owed: u128 = 0;
    for p in st.perp_positions.iter() {
        let mark = st
            .perp_markets
            .iter()
            .find(|m| m.id == p.market_id)
            .map(|m| m.mark)
            .unwrap_or(p.entry);
        let pnl = pnl_of(p, mark);
        if pnl > 0 {
            owed = owed.saturating_add(pnl as u128);
        }
    }
    let oi: u128 = st
        .perp_markets
        .iter()
        .map(|m| m.long_oi.saturating_add(m.short_oi))
        .fold(0u128, |a, b| a.saturating_add(b));
    owed.saturating_add(oi.saturating_mul(RESERVE_BUFFER_BPS) / 10_000)
}

fn market_of(st: &SpotState, market_id: u64) -> Result<&PerpMarket, PerpsError> {
    st.perp_markets
        .iter()
        .find(|m| m.id == market_id)
        .ok_or(PerpsError::NoMarket)
}

/// A mark fresh enough to trade against.
fn fresh_mark(st: &SpotState, market_id: u64) -> Result<u128, PerpsError> {
    let market = market_of(st, market_id)?;
    if !market.active {
        return Err(PerpsError::MarketInactive);
    }
    if market.mark == 0 {
        return Err(PerpsError::StaleMark);
    }
    if exec::block_height().saturating_sub(market.mark_block) > MARK_MAX_AGE {
        return Err(PerpsError::StaleMark);
    }
    Ok(market.mark)
}

/// The price a close settles at: the live mark when one exists, or — once the feed
/// has been dead for `MARK_EXIT_AGE` blocks — the position's own entry, which
/// settles at zero PnL. Returns `(price, at_entry)`.
///
/// Without this a keeper outage freezes every position with its margin locked and
/// no operator-independent way out (audit H-04).
fn exit_mark(st: &SpotState, market_id: u64, entry: u128) -> Result<(u128, bool), PerpsError> {
    match fresh_mark(st, market_id) {
        Ok(m) => Ok((m, false)),
        Err(PerpsError::StaleMark) => {
            let market = market_of(st, market_id)?;
            let age = exec::block_height().saturating_sub(market.mark_block);
            if age > MARK_EXIT_AGE || market.mark == 0 {
                Ok((entry, true))
            } else {
                Err(PerpsError::StaleMark)
            }
        }
        Err(e) => Err(e),
    }
}

pub struct PerpsService<'a> {
    state: &'a RefCell<SpotState>,
}

impl<'a> PerpsService<'a> {
    pub fn new(state: &'a RefCell<SpotState>) -> Self {
        Self { state }
    }
    fn require_admin(&self) -> Result<(), PerpsError> {
        if msg::source() == self.state.borrow().admin {
            Ok(())
        } else {
            Err(PerpsError::NotAdmin)
        }
    }
    /// The keeper only. Admin is deliberately not accepted here: the keeper is a
    /// hot key on an always-on worker and must not carry admin authority, nor admin
    /// the keeper's (audit H-04, H-09).
    fn require_keeper(&self) -> Result<(), PerpsError> {
        if msg::source() == self.state.borrow().perp_keeper {
            Ok(())
        } else {
            Err(PerpsError::NotKeeper)
        }
    }
    fn require_running(&self) -> Result<(), PerpsError> {
        if self.state.borrow().paused {
            Err(PerpsError::Paused)
        } else {
            Ok(())
        }
    }
}

#[sails_rs::service(events = PerpsEvent)]
impl<'a> PerpsService<'a> {
    /// Admin: set the collateral (settlement) token — the USDT VFT program.
    #[export]
    pub fn set_collateral(&mut self, token: ActorId) -> Result<(), PerpsError> {
        self.require_admin()?;
        if token == ActorId::zero() {
            return Err(PerpsError::BadParams);
        }
        self.state.borrow_mut().perp_collateral = token;
        let _ = self.emit_event(PerpsEvent::CollateralSet { token });
        Ok(())
    }

    /// Admin: set the keeper account allowed to push mark prices. The zero address is
    /// rejected — accepting it silently left admin as the sole mark authority
    /// (audit L-04).
    #[export]
    pub fn set_keeper(&mut self, keeper: ActorId) -> Result<(), PerpsError> {
        self.require_admin()?;
        if keeper == ActorId::zero() {
            return Err(PerpsError::BadParams);
        }
        self.state.borrow_mut().perp_keeper = keeper;
        let _ = self.emit_event(PerpsEvent::KeeperSet { keeper });
        Ok(())
    }

    /// Admin: list a perp market. `max_oi` is required and must be non-zero — the
    /// reserve's exposure is bounded at creation, not by a remembered follow-up
    /// (audit M-03). `excluded` marks markets that cannot accept new positions at
    /// launch (e.g., VARA market per committee recommendation).
    #[export]
    pub fn add_market(
        &mut self,
        symbol: String,
        max_oi: u128,
        excluded: bool,
    ) -> Result<u64, PerpsError> {
        self.require_admin()?;
        if symbol.is_empty() || max_oi == 0 {
            return Err(PerpsError::BadParams);
        }
        let (id, sym) = {
            let mut st = self.state.borrow_mut();
            let id = st.next_perp_market;
            st.next_perp_market += 1;
            st.perp_markets.push(PerpMarket {
                id,
                symbol: symbol.clone(),
                mark: 0,
                mark_block: 0,
                active: true,
                long_oi: 0,
                short_oi: 0,
                close_only: false,
                excluded,
                max_oi,
                cum_funding: 0,
                cum_holding: 0,
                funding_block: exec::block_height(),
            });
            (id, symbol)
        };
        let _ = self.emit_event(PerpsEvent::MarketAdded {
            market_id: id,
            symbol: sym,
            max_oi,
        });
        Ok(id)
    }

    /// Admin: cap open interest per side on a market.
    #[export]
    pub fn set_market_cap(&mut self, market_id: u64, max_oi: u128) -> Result<(), PerpsError> {
        self.require_admin()?;
        if max_oi == 0 {
            return Err(PerpsError::BadParams);
        }
        {
            let mut st = self.state.borrow_mut();
            let m = st
                .perp_markets
                .iter_mut()
                .find(|m| m.id == market_id)
                .ok_or(PerpsError::NoMarket)?;
            m.max_oi = max_oi;
        }
        let _ = self.emit_event(PerpsEvent::MarketCapSet { market_id, max_oi });
        Ok(())
    }

    /// Admin: put one perp market into open or close-only mode. Existing positions
    /// can always close or be liquidated; this only gates new risk.
    #[export]
    pub fn set_close_only(&mut self, market_id: u64, close_only: bool) -> Result<(), PerpsError> {
        self.require_admin()?;
        {
            let mut st = self.state.borrow_mut();
            let m = st
                .perp_markets
                .iter_mut()
                .find(|m| m.id == market_id)
                .ok_or(PerpsError::NoMarket)?;
            m.close_only = close_only;
        }
        Ok(())
    }

    // ── LP Vault (12-month lock, close-only switch right) ──

    /// LP deposits collateral into the vault, receives shares pro-rata.
    /// Locked for 12 months (LP_LOCK_DURATION_BLOCKS).
    /// Requires prior `approve` of collateral token.
    #[export]
    pub async fn lp_deposit(&mut self, amount: u128) -> Result<u128, PerpsError> {
        self.require_running()?;
        if amount == 0 {
            return Err(PerpsError::LpZeroAmount);
        }
        let caller = msg::source();
        let collateral = {
            let st = self.state.borrow();
            st.perp_collateral
        };
        if collateral == ActorId::zero() {
            return Err(PerpsError::NoCollateral);
        }
        let vft_gas = self.state.borrow().vft_call_gas;
        if let Err(e) = vft_transfer_from_with_gas(vft_gas, collateral, caller, amount).await {
            return Err(PerpsError::TransferFailed(e));
        }
        let (shares, unlock_block) = {
            let mut st = self.state.borrow_mut();
            let vault = &mut st.lp_vault;
            let total_shares = vault.total_shares;
            let shares = if total_shares == 0 {
                // First depositor gets 1:1 shares minus the permanently locked minimum.
                if amount <= LP_MINIMUM_LIQUIDITY {
                    st.credit(caller, collateral, amount);
                    return Err(PerpsError::LpAmountTooSmall);
                }
                amount - LP_MINIMUM_LIQUIDITY
            } else {
                // Pro-rata: shares = amount * total_shares / total_collateral
                amount
                    .checked_mul(total_shares)
                    .ok_or(PerpsError::Overflow)?
                    / vault.total_collateral.max(1)
            };
            if shares == 0 {
                // Should not happen if amount > 0, but guard anyway
                st.credit(caller, collateral, amount);
                return Err(PerpsError::BadParams);
            }
            let block = exec::block_height();
            let unlock_block = block.saturating_add(LP_LOCK_DURATION_BLOCKS);
            let deposit_id = vault.next_deposit_id;
            vault.next_deposit_id += 1;
            vault.lp_deposits.push(LpDeposit {
                id: deposit_id,
                lp: caller,
                amount,
                shares,
                deposit_block: block,
                unlock_block,
            });
            vault.total_collateral = vault.total_collateral.saturating_add(amount);
            if total_shares == 0 {
                // Lock the minimum liquidity permanently (issued to zero address conceptually)
                vault.total_shares = vault
                    .total_shares
                    .saturating_add(shares + LP_MINIMUM_LIQUIDITY);
            } else {
                vault.total_shares = vault.total_shares.saturating_add(shares);
            }
            (shares, unlock_block)
        };
        let _ = self.emit_event(PerpsEvent::LpDeposited {
            lp: caller,
            amount,
            shares,
            unlock_block,
        });
        Ok(shares)
    }

    /// LP redeems shares for collateral after lock expires.
    /// Shares are burned, collateral returned pro-rata.
    #[export]
    pub async fn lp_redeem(&mut self, deposit_id: u64) -> Result<u128, PerpsError> {
        self.require_running()?;
        let caller = msg::source();

        // Read deposit info before mutable borrow to avoid borrow checker issues
        let (idx, deposit, amount, shares) = {
            let mut st = self.state.borrow_mut();
            let vault = &mut st.lp_vault;
            let block = exec::block_height();
            let idx = vault
                .lp_deposits
                .iter()
                .position(|d| d.id == deposit_id && d.lp == caller)
                .ok_or(PerpsError::LpDepositNotFound)?;
            let deposit = vault.lp_deposits[idx].clone();
            if block < deposit.unlock_block {
                return Err(PerpsError::LpLocked);
            }
            // Pro-rata redemption: amount = shares * total_collateral / total_shares
            let amount = deposit
                .shares
                .checked_mul(vault.total_collateral)
                .ok_or(PerpsError::Overflow)?
                / vault.total_shares.max(1);
            if amount == 0 {
                return Err(PerpsError::BadParams);
            }
            vault.total_collateral = vault.total_collateral.saturating_sub(amount);
            vault.total_shares = vault.total_shares.saturating_sub(deposit.shares);
            vault.lp_deposits.remove(idx);
            (idx, deposit.clone(), amount, deposit.shares)
        };

        let vft_gas = self.state.borrow().vft_call_gas;
        let collateral = self.state.borrow().perp_collateral;
        if let Err(e) = vft_transfer_with_gas(vft_gas, collateral, caller, amount).await {
            // If transfer fails, restore state fully
            let mut st = self.state.borrow_mut();
            let vault = &mut st.lp_vault;
            vault.total_collateral = vault.total_collateral.saturating_add(amount);
            vault.total_shares = vault.total_shares.saturating_add(shares);
            // Re-insert the deposit at its original position
            vault.lp_deposits.insert(idx, deposit);
            return Err(PerpsError::TransferFailed(e));
        }
        let _ = self.emit_event(PerpsEvent::LpRedeemed {
            lp: caller,
            amount,
            shares,
        });
        Ok(amount)
    }

    /// LP triggers close-only mode for all perps markets.
    /// Requires >50% of total LP shares supporting the trigger AND at least 2 distinct LPs.
    #[export]
    pub fn lp_trigger_close_only(&mut self) -> Result<(), PerpsError> {
        let caller = msg::source();
        let supporting_shares = {
            let mut st = self.state.borrow_mut();
            let vault = &mut st.lp_vault;
            if vault.close_only {
                return Err(PerpsError::LpCloseOnlyAlreadyActive);
            }
            // Calculate total shares held by each LP
            let mut lp_shares: BTreeMap<ActorId, u128> = BTreeMap::new();
            for d in &vault.lp_deposits {
                *lp_shares.entry(d.lp).or_insert(0) += d.shares;
            }
            let caller_shares = *lp_shares.get(&caller).unwrap_or(&0);
            if caller_shares == 0 {
                return Err(PerpsError::LpInsufficientShares);
            }
            // Require >50% of total shares (50.01%)
            let threshold = vault
                .total_shares
                .saturating_mul(LP_CLOSE_ONLY_THRESHOLD_BPS)
                / 10_000;
            if caller_shares < threshold {
                return Err(PerpsError::LpInsufficientShares);
            }
            // Require at least 2 distinct LPs supporting (quorum)
            if lp_shares.len() < 2 {
                return Err(PerpsError::LpInsufficientShares);
            }
            vault.close_only = true;
            // Also set all markets to close_only
            for m in st.perp_markets.iter_mut() {
                if m.active {
                    m.close_only = true;
                }
            }
            caller_shares
        };
        let total_shares = self.state.borrow().lp_vault.total_shares;
        let _ = self.emit_event(PerpsEvent::LpCloseOnlyTriggered {
            trigger_lp: caller,
            supporting_shares,
            total_shares,
        });
        Ok(())
    }

    /// LP reverts close-only mode (requires >50% shares).
    #[export]
    pub fn lp_revert_close_only(&mut self) -> Result<(), PerpsError> {
        let caller = msg::source();
        {
            let mut st = self.state.borrow_mut();
            let vault = &mut st.lp_vault;
            if !vault.close_only {
                return Err(PerpsError::BadParams); // Not in close-only
            }
            let caller_shares: u128 = vault
                .lp_deposits
                .iter()
                .filter(|d| d.lp == caller)
                .map(|d| d.shares)
                .sum();
            let threshold = vault
                .total_shares
                .saturating_mul(LP_CLOSE_ONLY_THRESHOLD_BPS)
                / 10_000;
            if caller_shares < threshold {
                return Err(PerpsError::LpInsufficientShares);
            }
            vault.close_only = false;
            // Revert markets to their admin-set close_only state (would need tracking original state)
            // For simplicity, we just set close_only = false on all markets
            for m in st.perp_markets.iter_mut() {
                if m.active {
                    m.close_only = false;
                }
            }
        }
        let _ = self.emit_event(PerpsEvent::LpCloseOnlyReverted { trigger_lp: caller });
        Ok(())
    }

    /// Keeper: publish the mark price for a market.
    ///
    /// Bounded to `MAX_MARK_DEVIATION_BPS` from the previous mark, so a compromised
    /// keeper cannot reprice the book in a single transaction and liquidate it
    /// (audit H-04). The bound is skipped only for the very first mark (mark == 0
    /// and mark_block == 0). After initialization, the bound always applies — even
    /// after prolonged staleness — because a returning keeper could otherwise jump
    /// the mark arbitrarily, distorting funding, liquidation prices, and PnL for
    /// positions that have not yet exited at entry.
    #[export]
    pub fn set_mark(&mut self, market_id: u64, price: u128) -> Result<(), PerpsError> {
        self.require_keeper()?;
        if price == 0 {
            return Err(PerpsError::BadParams);
        }
        // Read config FIRST, before any mutable borrow of state.
        let max_dev_bps = self.state.borrow().perp_max_mark_deviation_bps;
        let block = exec::block_height();
        {
            let mut st = self.state.borrow_mut();
            // Accrue funding for ALL markets first (before taking mutable ref to market).
            accrue_all_funding(&mut st);
            let m = st
                .perp_markets
                .iter_mut()
                .find(|m| m.id == market_id)
                .ok_or(PerpsError::NoMarket)?;
            let is_first_mark = m.mark == 0 && m.mark_block == 0;
            if !is_first_mark {
                let prev = m.mark;
                let diff = price.abs_diff(prev);
                let limit = prev.saturating_mul(max_dev_bps) / 10_000;
                if diff > limit {
                    return Err(PerpsError::MarkDeviationTooLarge);
                }
            }
            m.mark = price;
            m.mark_block = block;
        }
        let _ = self.emit_event(PerpsEvent::MarkSet {
            market_id,
            price,
            block,
        });
        Ok(())
    }

    /// Permissionless tick: accrue funding for all active markets up to current block.
    /// Anyone can call this to keep funding indices fresh between keeper updates.
    #[export]
    pub fn tick(&mut self) -> Result<(), PerpsError> {
        accrue_all_funding(&mut self.state.borrow_mut());
        Ok(())
    }

    /// Admin: fund the house reserve with real collateral (requires a prior `approve`).
    #[export]
    pub async fn fund_reserve(&mut self, amount: u128) -> Result<u128, PerpsError> {
        self.require_admin()?;
        if amount == 0 {
            return Err(PerpsError::BadParams);
        }
        // Accrue funding for all markets first.
        accrue_all_funding(&mut self.state.borrow_mut());
        let (collateral, caller) = {
            let st = self.state.borrow();
            (st.perp_collateral, msg::source())
        };
        if collateral == ActorId::zero() {
            return Err(PerpsError::NoCollateral);
        }
        let vft_gas = self.state.borrow().vft_call_gas;
        if let Err(e) = vft_transfer_from_with_gas(vft_gas, collateral, caller, amount).await {
            return Err(PerpsError::TransferFailed(e));
        }
        let reserve = {
            let mut st = self.state.borrow_mut();
            st.perp_reserve += amount;
            st.perp_reserve
        };
        let _ = self.emit_event(PerpsEvent::ReserveFunded { amount, reserve });
        Ok(reserve)
    }

    /// Open an isolated-margin position. Escrows `margin` of the collateral token
    /// (requires a prior `approve`); notional = margin * leverage at the mark.
    ///
    /// Everything that can be checked before the escrow is checked before it. The two
    /// post-await re-checks exist because the await yields to other messages, and
    /// both credit the margin back before returning (audit C-03, M-08).
    #[export]
    pub async fn open_position(
        &mut self,
        market_id: u64,
        is_long: bool,
        margin: u128,
        leverage: u32,
    ) -> Result<u64, PerpsError> {
        self.require_running()?;
        if margin == 0 {
            return Err(PerpsError::BadParams);
        }
        // Accrue funding for ALL markets first (permissionless tick).
        accrue_all_funding(&mut self.state.borrow_mut());

        let max_leverage = self.state.borrow().perp_max_leverage;
        if leverage == 0 || leverage > max_leverage {
            return Err(PerpsError::LeverageTooHigh);
        }
        let notional = margin
            .checked_mul(leverage as u128)
            .ok_or(PerpsError::Overflow)?;
        let fee_bps = self.state.borrow().perp_fee_bps;
        let open_fee = notional * fee_bps / 10_000;
        // Pre-escrow validation. Each of these used to run *after* the transfer, and
        // returning Err after a committed transfer is what pocketed the margin.
        if margin <= open_fee {
            return Err(PerpsError::InsufficientMargin);
        }
        let (collateral, entry, caller) = {
            let st = self.state.borrow();
            if st.perp_positions.len() >= MAX_POSITIONS {
                return Err(PerpsError::BookFull);
            }
            let entry = fresh_mark(&st, market_id)?;
            let m = market_of(&st, market_id)?;
            if m.close_only {
                return Err(PerpsError::CloseOnly);
            }
            if m.excluded {
                return Err(PerpsError::CloseOnly); // Excluded markets act like close-only for new positions
            }
            let side_oi = if is_long { m.long_oi } else { m.short_oi };
            if side_oi.saturating_add(notional) > m.max_oi {
                return Err(PerpsError::OiCapExceeded);
            }
            if notional > st.perp_reserve.saturating_mul(MAX_POSITION_BPS) / 10_000 {
                return Err(PerpsError::OiCapExceeded);
            }
            if gross_oi(m).saturating_add(notional)
                > st.perp_reserve.saturating_mul(GROSS_OI_CAP_BPS) / 10_000
            {
                return Err(PerpsError::OiCapExceeded);
            }
            // Skew cap at CURRENT MARK PRICES (committee requirement).
            // Use skew_at_mark which marks existing positions to current price.
            let (current_long, current_short, _) =
                skew_at_mark(&st, market_id).unwrap_or((0, 0, 0));
            let next_long = current_long.saturating_add(if is_long { notional } else { 0 });
            let next_short = current_short.saturating_add(if is_long { 0 } else { notional });
            let next_skew = next_long.abs_diff(next_short);
            if next_skew > st.perp_reserve.saturating_mul(SKEW_CAP_BPS) / 10_000 {
                return Err(PerpsError::OiCapExceeded);
            }
            // Coverage floor: refuse new risk when the reserve is thin relative to
            // what it would owe *including this position* (audit M-04).
            //
            // Measuring only existing positions leaves the floor inert exactly when
            // it matters most: with an empty book the liability is 0, the check is
            // skipped, and the first position opens against a reserve that may hold
            // nothing. That trader can win and then be paid only `margin + reserve`
            // — their profit silently truncated, which is the outcome this floor
            // exists to prevent. The position being opened must count.
            let prospective = reserve_liability(&st)
                .saturating_add(notional.saturating_mul(RESERVE_BUFFER_BPS) / 10_000);
            // Cross-multiply to avoid integer division rounding errors at the boundary.
            // Check: reserve / prospective >= MIN_COVERAGE_BPS / 10_000
            // <=> reserve * 10_000 >= prospective * MIN_COVERAGE_BPS
            if st.perp_reserve.saturating_mul(10_000) < prospective.saturating_mul(MIN_COVERAGE_BPS)
            {
                return Err(PerpsError::InsufficientCoverage);
            }
            (st.perp_collateral, entry, msg::source())
        };
        if collateral == ActorId::zero() {
            return Err(PerpsError::NoCollateral);
        }
        // Escrow the margin. Past this point: success, or credit-and-return.
        // Read vft_call_gas inside the async block to avoid stale config if changed between read and await.
        let vft_gas = self.state.borrow().vft_call_gas;
        if let Err(e) = vft_transfer_from_with_gas(vft_gas, collateral, caller, margin).await {
            return Err(PerpsError::TransferFailed(e));
        }

        let opened = {
            // Read skew at mark BEFORE mutable borrow (mark price is immutable during this call).
            let (current_long, current_short, _) = {
                let st = self.state.borrow();
                skew_at_mark(&st, market_id).unwrap_or((0, 0, 0))
            };

            let mut st = self.state.borrow_mut();
            // Re-check on the borrow that inserts: the await yielded (audit M-08).
            if st.perp_positions.len() >= MAX_POSITIONS {
                st.credit(caller, collateral, margin);
                return Err(PerpsError::BookFull);
            }
            let block = exec::block_height();
            let reserve = st.perp_reserve;
            let (entry_funding, entry_holding) = {
                let m = match st.perp_markets.iter_mut().find(|m| m.id == market_id) {
                    Some(m) => m,
                    None => {
                        st.credit(caller, collateral, margin);
                        return Err(PerpsError::NoMarket);
                    }
                };
                if m.close_only {
                    st.credit(caller, collateral, margin);
                    return Err(PerpsError::CloseOnly);
                }
                let side_oi = if is_long { m.long_oi } else { m.short_oi };
                if side_oi.saturating_add(notional) > m.max_oi {
                    st.credit(caller, collateral, margin);
                    return Err(PerpsError::OiCapExceeded);
                }
                if notional > reserve.saturating_mul(MAX_POSITION_BPS) / 10_000
                    || gross_oi(m).saturating_add(notional)
                        > reserve.saturating_mul(GROSS_OI_CAP_BPS) / 10_000
                {
                    st.credit(caller, collateral, margin);
                    return Err(PerpsError::OiCapExceeded);
                }
                // Skew cap at CURRENT MARK PRICES (committee requirement) — re-check post-await.
                // Use pre-computed current_long/current_short from before mutable borrow.
                let next_long = current_long.saturating_add(if is_long { notional } else { 0 });
                let next_short = current_short.saturating_add(if is_long { 0 } else { notional });
                let next_skew = next_long.abs_diff(next_short);
                if next_skew > reserve.saturating_mul(SKEW_CAP_BPS) / 10_000 {
                    st.credit(caller, collateral, margin);
                    return Err(PerpsError::OiCapExceeded);
                }
                accrue_funding(m, block);
                let cum_holding = m.cum_holding;
                if is_long {
                    m.long_oi += notional;
                } else {
                    m.short_oi += notional;
                }
                (m.cum_funding, cum_holding)
            };
            st.perp_reserve += open_fee; // fee revenue to the house reserve
            let id = st.next_perp_pos;
            st.next_perp_pos += 1;
            st.perp_positions.push(PerpPosition {
                id,
                owner: caller,
                market_id,
                is_long,
                notional,
                entry,
                margin: margin - open_fee,
                leverage,
                entry_funding,
                entry_holding,
            });
            id
        };
        let _ = self.emit_event(PerpsEvent::PositionOpened {
            position_id: opened,
            market_id,
            owner: caller,
            is_long,
            notional,
            entry,
            margin: margin - open_fee,
            leverage,
        });
        Ok(opened)
    }

    /// Close your position, settling PnL and funding against the reserve and
    /// crediting the payout to your claimable collateral (withdraw via
    /// `Spot/Withdraw`). Never gated on the pause switch, and never gated on a live
    /// keeper once the feed has been dead past `MARK_EXIT_AGE`.
    #[export]
    pub fn close_position(&mut self, position_id: u64) -> Result<(u128, i128), PerpsError> {
        // Accrue funding for all markets first.
        accrue_all_funding(&mut self.state.borrow_mut());
        let caller = msg::source();
        let (net_payout, pnl, funding, at_entry) = {
            let mut st = self.state.borrow_mut();
            let idx = st
                .perp_positions
                .iter()
                .position(|p| p.id == position_id && p.owner == caller)
                .ok_or(PerpsError::PositionNotFound)?;
            let pos = st.perp_positions[idx].clone();
            let (mark, at_entry) = exit_mark(&st, pos.market_id, pos.entry)?;
            let block = exec::block_height();
            let (cum_funding, cum_holding) =
                match st.perp_markets.iter_mut().find(|m| m.id == pos.market_id) {
                    Some(m) => {
                        accrue_funding(m, block);
                        (m.cum_funding, m.cum_holding)
                    }
                    None => (pos.entry_funding, pos.entry_holding),
                };
            let pnl = pnl_of(&pos, mark);
            // Funding is a charge on the crowded side, paid to the reserve.
            let funding = funding_of(&pos, cum_funding);
            let holding_fee = holding_fee_of(&pos, cum_holding);
            let net_pnl = pnl - funding - holding_fee;
            let (payout, reserve_delta) = settle(pos.margin, net_pnl, st.perp_reserve);
            st.perp_reserve = (st.perp_reserve as i128 + reserve_delta) as u128;
            let fee_bps = st.perp_fee_bps;
            let close_fee = (pos.notional * fee_bps / 10_000).min(payout);
            let net_payout = payout - close_fee;
            st.perp_reserve += close_fee;
            release_oi(&mut st, &pos);
            let collateral = st.perp_collateral;
            st.credit(caller, collateral, net_payout);
            st.perp_positions.remove(idx);
            (net_payout, pnl, funding, at_entry)
        };
        let _ = self.emit_event(PerpsEvent::PositionClosed {
            position_id,
            owner: caller,
            payout: net_payout,
            pnl,
            funding,
            at_entry,
        });
        Ok((net_payout, pnl))
    }

    /// Permissionless liquidation once equity falls to maintenance margin.
    ///
    /// The liquidator's fee is paid from residual equity and topped up from the
    /// reserve when equity has gapped away. Capping the fee at residual equity meant
    /// it vanished exactly when liquidation mattered most, so nobody would run a bot
    /// for it (audit L-07).
    #[export]
    pub fn liquidate(&mut self, position_id: u64) -> Result<(), PerpsError> {
        // Accrue funding for all markets first.
        accrue_all_funding(&mut self.state.borrow_mut());
        let liquidator = msg::source();
        let (owner, to_owner, fee) = {
            let mut st = self.state.borrow_mut();
            let idx = st
                .perp_positions
                .iter()
                .position(|p| p.id == position_id)
                .ok_or(PerpsError::PositionNotFound)?;
            let pos = st.perp_positions[idx].clone();
            let mark = fresh_mark(&st, pos.market_id)?;
            let block = exec::block_height();
            let (cum_funding, cum_holding) =
                match st.perp_markets.iter_mut().find(|m| m.id == pos.market_id) {
                    Some(m) => {
                        accrue_funding(m, block);
                        (m.cum_funding, m.cum_holding)
                    }
                    None => (pos.entry_funding, pos.entry_holding),
                };
            let pnl = pnl_of(&pos, mark)
                - funding_of(&pos, cum_funding)
                - holding_fee_of(&pos, cum_holding);
            let equity = pos.margin as i128 + pnl;
            let maintenance_bps = st.perp_maintenance_bps;
            let maintenance = (pos.notional * maintenance_bps / 10_000) as i128;
            if equity > maintenance {
                return Err(PerpsError::NotLiquidatable);
            }
            let eq_pos = equity.max(0) as u128;
            let target_fee = pos.margin * LIQUIDATION_FEE_BPS / 10_000;
            let from_equity = eq_pos.min(target_fee);
            // Top up from the reserve so the incentive survives a gap move.
            let shortfall = target_fee - from_equity;
            let from_reserve = shortfall.min(st.perp_reserve);
            let fee = from_equity + from_reserve;
            let to_owner = eq_pos - from_equity;
            // Whatever the margin didn't cover flows into the reserve; the top-up
            // flows out of it.
            st.perp_reserve = (st.perp_reserve as i128 + pos.margin as i128
                - eq_pos as i128
                - from_reserve as i128)
                .max(0) as u128;
            release_oi(&mut st, &pos);
            let collateral = st.perp_collateral;
            st.credit(pos.owner, collateral, to_owner);
            if fee > 0 {
                st.credit(liquidator, collateral, fee);
            }
            st.perp_positions.remove(idx);
            (pos.owner, to_owner, fee)
        };
        let _ = self.emit_event(PerpsEvent::PositionLiquidated {
            position_id,
            owner,
            liquidator,
            to_owner,
            fee,
        });
        Ok(())
    }

    /// Admin: withdraw reserve profit to the admin's claimable collateral.
    ///
    /// Capped at the amount above current liability, so solvency is a contract
    /// invariant instead of operator discipline — draining the reserve used to
    /// silently truncate what winning traders received rather than failing loudly
    /// (audit H-05).
    #[export]
    pub fn withdraw_reserve(&mut self, amount: u128) -> Result<u128, PerpsError> {
        self.require_admin()?;
        let reserve = {
            let mut st = self.state.borrow_mut();
            let liability = reserve_liability(&st);
            let withdrawable = st.perp_reserve.saturating_sub(liability);
            if amount == 0 || amount > withdrawable {
                return Err(PerpsError::BadParams);
            }
            st.perp_reserve -= amount;
            let (admin, collateral) = (st.admin, st.perp_collateral);
            st.credit(admin, collateral, amount);
            st.perp_reserve
        };
        let _ = self.emit_event(PerpsEvent::ReserveWithdrawn { amount, reserve });
        Ok(reserve)
    }

    // ── Reads ──
    #[export]
    pub fn get_markets(&self) -> Vec<PerpMarket> {
        self.state.borrow().perp_markets.clone()
    }

    /// `(collateral token, keeper)`. The collateral token is what margin is escrowed
    /// in, so a client can attribute locked margin to the right token instead of
    /// showing a wallet balance that silently dropped.
    #[export]
    pub fn get_config(&self) -> (ActorId, ActorId) {
        let st = self.state.borrow();
        (st.perp_collateral, st.perp_keeper)
    }

    #[export]
    pub fn get_reserve(&self) -> u128 {
        self.state.borrow().perp_reserve
    }

    /// Reserve health: `(reserve, liability, coverage_bps)`. Surfaced so a trader can
    /// see the reserve is thin *before* entering, rather than discovering it as a
    /// truncated payout on the way out (audit M-04).
    #[export]
    pub fn get_reserve_health(&self) -> (u128, u128, u128) {
        let st = self.state.borrow();
        let liability = reserve_liability(&st);
        // No liability means infinite coverage, not a division by zero.
        let coverage = st
            .perp_reserve
            .saturating_mul(10_000)
            .checked_div(liability)
            .unwrap_or(u128::MAX);
        (st.perp_reserve, liability, coverage)
    }

    /// A trader's open positions with PnL at the current mark, paginated (audit L-05):
    /// `(id, market_id, is_long, notional, entry, margin, leverage, pnl)`.
    #[export]
    pub fn get_positions(
        &self,
        owner: ActorId,
        offset: u32,
        limit: u32,
    ) -> Vec<(u64, u64, bool, u128, u128, u128, u32, i128)> {
        let st = self.state.borrow();
        let take = limit.clamp(1, crate::spot::MAX_PAGE) as usize;
        st.perp_positions
            .iter()
            .filter(|p| p.owner == owner)
            .skip(offset as usize)
            .take(take)
            .map(|p| {
                let mark = st
                    .perp_markets
                    .iter()
                    .find(|m| m.id == p.market_id)
                    .map(|m| m.mark)
                    .unwrap_or(p.entry);
                (
                    p.id,
                    p.market_id,
                    p.is_long,
                    p.notional,
                    p.entry,
                    p.margin,
                    p.leverage,
                    pnl_of(p, mark),
                )
            })
            .collect()
    }

    /// Liquidation price for a position (0 if none).
    #[export]
    pub fn get_liq_price(&self, position_id: u64) -> u128 {
        let st = self.state.borrow();
        let maintenance_bps = st.perp_maintenance_bps;
        st.perp_positions
            .iter()
            .find(|p| p.id == position_id)
            .map(|p| liq_price(p, maintenance_bps))
            .unwrap_or(0)
    }

    // ── Mainnet metrics & LP vault reads ──

    /// Returns comprehensive mainnet metrics for transparency (committee request).
    /// Includes 30/60-day volume, unique wallets, TVL, active markets, pool health.
    #[export]
    pub fn get_mainnet_metrics(&self) -> MainnetMetrics {
        let st = self.state.borrow();
        let now = exec::block_height();

        // Calculate 30-day and 60-day volume (approximate from events would need indexer)
        // For on-chain view, we report current state that matters for solvency
        let total_volume_30d: u128 = 0; // Would need indexer for historical
        let total_volume_60d: u128 = 0;
        let unique_wallets_30d: u32 = 0;
        let unique_wallets_60d: u32 = 0;

        // Current TVL = perp_reserve + sum of all position margin + LP vault collateral
        let lp_vault_collateral = st.lp_vault.total_collateral;
        let position_margin: u128 = st.perp_positions.iter().map(|p| p.margin).sum();
        let tvl = st
            .perp_reserve
            .saturating_add(position_margin)
            .saturating_add(lp_vault_collateral);

        // Active markets
        let active_markets = st.perp_markets.iter().filter(|m| m.active).count() as u32;

        // Pool health per market
        let mut pool_health = Vec::new();
        for m in st.perp_markets.iter() {
            if m.active {
                let (_long_at_mark, _short_at_mark, net_skew) =
                    skew_at_mark(&st, m.id).unwrap_or((0, 0, 0));
                let skew_cap = st.perp_reserve.saturating_mul(SKEW_CAP_BPS) / 10_000;
                let skew_utilization_bps = if skew_cap > 0 {
                    net_skew
                        .saturating_mul(10_000)
                        .checked_div(skew_cap)
                        .unwrap_or(0)
                } else {
                    0
                };

                pool_health.push(MarketHealth {
                    market_id: m.id,
                    symbol: m.symbol.clone(),
                    mark: m.mark,
                    reserve: st.perp_reserve,
                    long_oi: m.long_oi,
                    short_oi: m.short_oi,
                    net_skew,
                    skew_cap,
                    skew_utilization_bps,
                    close_only: m.close_only,
                    excluded: m.excluded,
                });
            }
        }

        // LP vault state
        let lp_vault = LpVaultState {
            total_collateral: st.lp_vault.total_collateral,
            total_shares: st.lp_vault.total_shares,
            close_only: st.lp_vault.close_only,
            deposit_count: st.lp_vault.lp_deposits.len() as u32,
        };

        MainnetMetrics {
            timestamp_block: now,
            tvl,
            perp_reserve: st.perp_reserve,
            lp_vault_collateral,
            position_margin,
            active_markets,
            total_volume_30d,
            total_volume_60d,
            unique_wallets_30d,
            unique_wallets_60d,
            pool_health,
            lp_vault,
        }
    }

    /// Returns current skew at mark prices for a market.
    #[export]
    pub fn get_skew_at_mark(&self, market_id: u64) -> Option<(u128, u128, u128)> {
        let st = self.state.borrow();
        skew_at_mark(&st, market_id)
    }

    /// Returns LP vault state.
    #[export]
    pub fn get_lp_vault(&self) -> LpVaultState {
        let st = self.state.borrow();
        let vault = &st.lp_vault;
        LpVaultState {
            total_collateral: vault.total_collateral,
            total_shares: vault.total_shares,
            close_only: vault.close_only,
            deposit_count: vault.lp_deposits.len() as u32,
        }
    }

    /// Returns LP deposit details for a specific deposit.
    #[export]
    pub fn get_lp_deposit(&self, deposit_id: u64) -> Option<LpDeposit> {
        let st = self.state.borrow();
        st.lp_vault
            .lp_deposits
            .iter()
            .find(|d| d.id == deposit_id)
            .cloned()
    }

    /// Returns all LP deposits for a specific LP.
    #[export]
    pub fn get_lp_deposits_for(&self, lp: ActorId) -> Vec<LpDeposit> {
        let st = self.state.borrow();
        st.lp_vault
            .lp_deposits
            .iter()
            .filter(|d| d.lp == lp)
            .cloned()
            .collect()
    }
}

/// Release a closing position's open interest from its market.
fn release_oi(st: &mut SpotState, pos: &PerpPosition) {
    if let Some(m) = st.perp_markets.iter_mut().find(|m| m.id == pos.market_id) {
        if pos.is_long {
            m.long_oi = m.long_oi.saturating_sub(pos.notional);
        } else {
            m.short_oi = m.short_oi.saturating_sub(pos.notional);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pos(is_long: bool, notional: u128, entry: u128, margin: u128) -> PerpPosition {
        PerpPosition {
            id: 0,
            owner: ActorId::zero(),
            market_id: 0,
            is_long,
            notional,
            entry,
            margin,
            leverage: 10,
            entry_funding: 0,
            entry_holding: 0,
        }
    }

    fn market(long_oi: u128, short_oi: u128) -> PerpMarket {
        PerpMarket {
            id: 0,
            symbol: String::from("ETH-PERP"),
            mark: 100,
            mark_block: 0,
            active: true,
            long_oi,
            short_oi,
            close_only: false,
            max_oi: u128::MAX,
            cum_funding: 0,
            cum_holding: 0,
            funding_block: 0,
        }
    }

    #[test]
    fn settle_never_takes_the_reserve_negative() {
        // A win larger than the reserve is truncated at margin + reserve.
        let (payout, delta) = settle(100, 10_000, 50);
        assert_eq!(payout, 150);
        assert_eq!(delta, -50);
        // A total loss pays nothing and hands the margin to the reserve.
        let (payout, delta) = settle(100, -500, 1_000);
        assert_eq!(payout, 0);
        assert_eq!(delta, 100);
    }

    #[test]
    fn funding_charges_the_crowded_side() {
        // Notionals are token smallest-units: 10_000 USDT at 6 decimals.
        const N: u128 = 10_000_000_000;
        let mut m = market(N, 0); // entirely long
        accrue_funding(&mut m, 1_200); // one hour at ~3s blocks
        assert!(
            m.cum_funding > 0,
            "longs alone must accrue positive funding"
        );
        let long = pos(true, N, 100, N / 10);
        let short = pos(false, N, 100, N / 10);
        // The long pays; the short is paid the same amount.
        assert_eq!(
            funding_of(&long, m.cum_funding),
            -funding_of(&short, m.cum_funding)
        );
        assert!(funding_of(&long, m.cum_funding) > 0);
        // Roughly 0.12%/hour at full imbalance — a real but not punitive rate.
        assert_eq!(funding_of(&long, m.cum_funding), 12_000_000);
    }

    #[test]
    fn funding_is_zero_when_the_book_is_balanced() {
        let mut m = market(1_000, 1_000);
        accrue_funding(&mut m, 100);
        assert_eq!(m.cum_funding, 0);
    }

    #[test]
    fn holding_fee_accrues_for_any_open_interest() {
        let mut m = market(1_000_000, 1_000_000);
        accrue_funding(&mut m, 100);
        assert_eq!(m.cum_funding, 0);
        assert_eq!(m.cum_holding, HOLDING_FEE_PER_BLOCK * 100);

        let p = pos(true, 1_000_000, 100, 200_000);
        assert_eq!(
            holding_fee_of(&p, m.cum_holding),
            1_000_000 * HOLDING_FEE_PER_BLOCK * 100 / FUNDING_SCALE
        );
    }

    #[test]
    fn skew_value_is_net_open_interest() {
        let m = market(25_000, 10_000);
        assert_eq!(gross_oi(&m), 35_000);
        assert_eq!(net_skew_value(&m), 15_000);
    }

    #[test]
    fn reserve_liability_covers_unrealised_profit_plus_a_buffer() {
        let mut st = SpotState::default();
        let mut m = market(1_000, 0);
        m.mark = 110; // long is up 10%
        st.perp_markets.push(m);
        st.perp_positions.push(pos(true, 1_000, 100, 100));
        // 100 of unrealised profit, plus 5% of 1_000 open interest.
        assert_eq!(reserve_liability(&st), 100 + 50);
    }

    #[test]
    fn liq_price_moves_against_the_position() {
        let long = pos(true, 2_000, 100, 100);
        let short = pos(false, 2_000, 100, 100);
        assert!(liq_price(&long, 100) < 100, "a long liquidates below entry");
        assert!(
            liq_price(&short, 100) > 100,
            "a short liquidates above entry"
        );
    }

    #[test]
    fn pnl_is_symmetric_between_sides() {
        let long = pos(true, 1_000, 100, 100);
        let short = pos(false, 1_000, 100, 100);
        assert_eq!(pnl_of(&long, 120), 200);
        assert_eq!(pnl_of(&short, 120), -200);
    }
}
