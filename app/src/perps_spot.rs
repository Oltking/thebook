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

use crate::spot::{SpotError, SpotState, vft_transfer_from};
use sails_rs::cell::RefCell;
use sails_rs::gstd::{exec, msg};
use sails_rs::prelude::*;
use sails_rs::scale_codec::{Decode, Encode};

extern crate alloc;
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
    TransferFailed,
    NoCollateral,
    /// Opening would push this side's open interest past the market cap.
    OiCapExceeded,
    /// Trading is paused. Closing and liquidating stay open.
    Paused,
    /// The mark update deviates further from the previous mark than the bound allows.
    MarkDeviationTooLarge,
    /// The reserve is too thin relative to what it already owes to accept new risk.
    InsufficientCoverage,
    /// An amount overflowed. Trapping beats a silently wrong number.
    Overflow,
}

impl From<SpotError> for PerpsError {
    fn from(e: SpotError) -> Self {
        match e {
            SpotError::Overflow => PerpsError::Overflow,
            SpotError::Paused => PerpsError::Paused,
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
    /// Max open interest per side. Required at market creation: there is no
    /// unlimited default, because the safe value should not depend on an operator
    /// remembering a second call (audit M-03).
    pub max_oi: u128,
    /// Cumulative funding index in `FUNDING_SCALE` units. Rises while longs are the
    /// crowded side, falls while shorts are. Longs pay the increase, shorts receive
    /// its negation; both settle against the reserve, which is the counterparty.
    pub cum_funding: i128,
    /// Block `cum_funding` was last advanced.
    pub funding_block: u32,
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

/// Advance a market's funding index to `block`, charging the crowded side.
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
    }
    m.funding_block = block;
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
pub fn liq_price(pos: &PerpPosition) -> u128 {
    if pos.notional == 0 || pos.entry == 0 {
        return 0;
    }
    let n = pos.notional as i128;
    let e = pos.entry as i128;
    let m = pos.margin as i128;
    let mm = MAINTENANCE_BPS as i128;
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
    /// (audit M-03).
    #[export]
    pub fn add_market(&mut self, symbol: String, max_oi: u128) -> Result<u64, PerpsError> {
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
                max_oi,
                cum_funding: 0,
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

    /// Keeper: publish the mark price for a market.
    ///
    /// Bounded to `MAX_MARK_DEVIATION_BPS` from the previous mark, so a compromised
    /// keeper cannot reprice the book in a single transaction and liquidate it
    /// (audit H-04). The bound is skipped only for the first mark, and once the feed
    /// is stale past `MARK_EXIT_AGE` — by then positions can already exit at entry,
    /// so a fresh start is not a lever over anyone.
    #[export]
    pub fn set_mark(&mut self, market_id: u64, price: u128) -> Result<(), PerpsError> {
        self.require_keeper()?;
        if price == 0 {
            return Err(PerpsError::BadParams);
        }
        let block = exec::block_height();
        {
            let mut st = self.state.borrow_mut();
            let m = st
                .perp_markets
                .iter_mut()
                .find(|m| m.id == market_id)
                .ok_or(PerpsError::NoMarket)?;
            let bootstrapping = m.mark == 0 || block.saturating_sub(m.mark_block) > MARK_EXIT_AGE;
            if !bootstrapping {
                let prev = m.mark;
                let diff = price.abs_diff(prev);
                let limit = prev.saturating_mul(MAX_MARK_DEVIATION_BPS) / 10_000;
                if diff > limit {
                    return Err(PerpsError::MarkDeviationTooLarge);
                }
            }
            // Funding accrues against the OI that existed up to this point.
            accrue_funding(m, block);
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

    /// Admin: fund the house reserve with real collateral (requires a prior `approve`).
    #[export]
    pub async fn fund_reserve(&mut self, amount: u128) -> Result<u128, PerpsError> {
        self.require_admin()?;
        if amount == 0 {
            return Err(PerpsError::BadParams);
        }
        let (collateral, caller) = {
            let st = self.state.borrow();
            (st.perp_collateral, msg::source())
        };
        if collateral == ActorId::zero() {
            return Err(PerpsError::NoCollateral);
        }
        if !vft_transfer_from(collateral, caller, amount).await {
            return Err(PerpsError::TransferFailed);
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
        if leverage == 0 || leverage > MAX_LEVERAGE {
            return Err(PerpsError::LeverageTooHigh);
        }
        let notional = margin
            .checked_mul(leverage as u128)
            .ok_or(PerpsError::Overflow)?;
        let open_fee = notional * FEE_BPS / 10_000;
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
            let side_oi = if is_long { m.long_oi } else { m.short_oi };
            if side_oi.saturating_add(notional) > m.max_oi {
                return Err(PerpsError::OiCapExceeded);
            }
            // Coverage floor: refuse new risk when the reserve is already thin
            // relative to what it owes (audit M-04).
            let liability = reserve_liability(&st);
            if liability > 0
                && st.perp_reserve.saturating_mul(10_000) / liability.max(1) < MIN_COVERAGE_BPS
            {
                return Err(PerpsError::InsufficientCoverage);
            }
            (st.perp_collateral, entry, msg::source())
        };
        if collateral == ActorId::zero() {
            return Err(PerpsError::NoCollateral);
        }
        // Escrow the margin. Past this point: success, or credit-and-return.
        if !vft_transfer_from(collateral, caller, margin).await {
            return Err(PerpsError::TransferFailed);
        }

        let opened = {
            let mut st = self.state.borrow_mut();
            // Re-check on the borrow that inserts: the await yielded (audit M-08).
            if st.perp_positions.len() >= MAX_POSITIONS {
                st.credit(caller, collateral, margin);
                return Err(PerpsError::BookFull);
            }
            let block = exec::block_height();
            let cum_funding = {
                let m = match st.perp_markets.iter_mut().find(|m| m.id == market_id) {
                    Some(m) => m,
                    None => {
                        st.credit(caller, collateral, margin);
                        return Err(PerpsError::NoMarket);
                    }
                };
                let side_oi = if is_long { m.long_oi } else { m.short_oi };
                if side_oi.saturating_add(notional) > m.max_oi {
                    st.credit(caller, collateral, margin);
                    return Err(PerpsError::OiCapExceeded);
                }
                accrue_funding(m, block);
                if is_long {
                    m.long_oi += notional;
                } else {
                    m.short_oi += notional;
                }
                m.cum_funding
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
                entry_funding: cum_funding,
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
            let cum_funding = match st.perp_markets.iter_mut().find(|m| m.id == pos.market_id) {
                Some(m) => {
                    accrue_funding(m, block);
                    m.cum_funding
                }
                None => pos.entry_funding,
            };
            let pnl = pnl_of(&pos, mark);
            // Funding is a charge on the crowded side, paid to the reserve.
            let funding = funding_of(&pos, cum_funding);
            let net_pnl = pnl - funding;
            let (payout, reserve_delta) = settle(pos.margin, net_pnl, st.perp_reserve);
            st.perp_reserve = (st.perp_reserve as i128 + reserve_delta) as u128;
            let close_fee = (pos.notional * FEE_BPS / 10_000).min(payout);
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
            let cum_funding = match st.perp_markets.iter_mut().find(|m| m.id == pos.market_id) {
                Some(m) => {
                    accrue_funding(m, block);
                    m.cum_funding
                }
                None => pos.entry_funding,
            };
            let pnl = pnl_of(&pos, mark) - funding_of(&pos, cum_funding);
            let equity = pos.margin as i128 + pnl;
            let maintenance = (pos.notional * MAINTENANCE_BPS / 10_000) as i128;
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
        st.perp_positions
            .iter()
            .find(|p| p.id == position_id)
            .map(liq_price)
            .unwrap_or(0)
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
            max_oi: u128::MAX,
            cum_funding: 0,
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
        assert!(liq_price(&long) < 100, "a long liquidates below entry");
        assert!(liq_price(&short) > 100, "a short liquidates above entry");
    }

    #[test]
    fn pnl_is_symmetric_between_sides() {
        let long = pos(true, 1_000, 100, 100);
        let short = pos(false, 1_000, 100, 100);
        assert_eq!(pnl_of(&long, 120), 200);
        assert_eq!(pnl_of(&short, 120), -200);
    }
}
