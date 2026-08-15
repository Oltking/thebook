//! v1 mainnet perps — cash-settled perpetual futures over the spot collateral token.
//!
//! Real-money adaptation of the legacy `perps.rs` (which used virtual balances). It
//! shares `SpotState`, so margin is escrowed in the real collateral token (USDT) via the
//! same async VFT path as spot, and PnL settles into the shared `claims` balance the user
//! withdraws with `Spot/Withdraw`. Positions are cash-settled: no base token is ever held
//! for a perp, only the collateral. A keeper pushes mark prices (GMX-style); a real
//! house reserve pays trader profit and absorbs losses.

use crate::spot::{vft_transfer_from, SpotState};
use sails_rs::cell::RefCell;
use sails_rs::gstd::{exec, msg};
use sails_rs::prelude::*;
use sails_rs::scale_codec::{Decode, Encode};

extern crate alloc;
use alloc::string::String;
use alloc::vec::Vec;

pub const MAX_LEVERAGE: u32 = 20;
/// Trading fee per side (open and close), in basis points of notional. Fees accrue to
/// the house reserve — that's the perps revenue on top of trader losses.
pub const FEE_BPS: u128 = 10; // 0.1%
/// Maintenance-margin requirement, in basis points of notional.
pub const MAINTENANCE_BPS: u128 = 50; // 0.5%
/// Liquidator's cut of residual equity, in basis points of margin.
pub const LIQUIDATION_FEE_BPS: u128 = 100; // 1%
/// Max age (blocks) of a mark before perp actions reject it as stale.
pub const MARK_MAX_AGE: u32 = 100;
pub const MAX_POSITIONS: usize = 10_000;

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
    /// Max open interest per side (u128::MAX = unlimited until the admin tightens it).
    pub max_oi: u128,
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
    // equity = margin + notional*(m-entry)/entry*(±1); maintenance = notional*mm/10000.
    // Solve for m. Work in i128.
    let n = pos.notional as i128;
    let e = pos.entry as i128;
    let m = pos.margin as i128;
    let mm = MAINTENANCE_BPS as i128;
    // long:  margin + n*(x-e)/e = n*mm/10000
    //        n*x/e = n*mm/10000 - margin + n  =>  x = e*(n*mm/10000 - margin + n)/n
    // short: margin - n*(x-e)/e = n*mm/10000  =>  x = e*(margin - n*mm/10000 + n)/n
    let nm = n * mm / 10_000;
    let num = if pos.is_long { nm - m + n } else { m - nm + n };
    let x = e * num / n;
    if x < 0 {
        0
    } else {
        x as u128
    }
}

fn fresh_mark(st: &SpotState, market_id: u64) -> Result<u128, PerpsError> {
    let market = st
        .perp_markets
        .iter()
        .find(|m| m.id == market_id)
        .ok_or(PerpsError::NoMarket)?;
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
    fn require_keeper(&self) -> Result<(), PerpsError> {
        let st = self.state.borrow();
        if msg::source() == st.perp_keeper || msg::source() == st.admin {
            Ok(())
        } else {
            Err(PerpsError::NotKeeper)
        }
    }
}

#[sails_rs::service]
impl<'a> PerpsService<'a> {
    /// Admin: set the collateral (settlement) token — the USDT VFT program.
    #[export]
    pub fn set_collateral(&mut self, token: ActorId) -> Result<(), PerpsError> {
        self.require_admin()?;
        if token == ActorId::zero() {
            return Err(PerpsError::BadParams);
        }
        self.state.borrow_mut().perp_collateral = token;
        Ok(())
    }

    /// Admin: set the keeper account allowed to push mark prices.
    #[export]
    pub fn set_keeper(&mut self, keeper: ActorId) -> Result<(), PerpsError> {
        self.require_admin()?;
        self.state.borrow_mut().perp_keeper = keeper;
        Ok(())
    }

    /// Admin: list a perp market by symbol. Returns its id.
    #[export]
    pub fn add_market(&mut self, symbol: String) -> Result<u64, PerpsError> {
        self.require_admin()?;
        if symbol.is_empty() {
            return Err(PerpsError::BadParams);
        }
        let mut st = self.state.borrow_mut();
        let id = st.next_perp_market;
        st.next_perp_market += 1;
        st.perp_markets.push(PerpMarket {
            id,
            symbol,
            mark: 0,
            mark_block: 0,
            active: true,
            long_oi: 0,
            short_oi: 0,
            max_oi: u128::MAX,
        });
        Ok(id)
    }

    /// Admin: cap open interest per side on a market, bounding the reserve's max loss.
    #[export]
    pub fn set_market_cap(&mut self, market_id: u64, max_oi: u128) -> Result<(), PerpsError> {
        self.require_admin()?;
        let mut st = self.state.borrow_mut();
        let m = st
            .perp_markets
            .iter_mut()
            .find(|m| m.id == market_id)
            .ok_or(PerpsError::NoMarket)?;
        m.max_oi = max_oi;
        Ok(())
    }

    /// Keeper: publish the mark price for a market.
    #[export]
    pub fn set_mark(&mut self, market_id: u64, price: u128) -> Result<(), PerpsError> {
        self.require_keeper()?;
        let block = exec::block_height();
        let mut st = self.state.borrow_mut();
        let m = st
            .perp_markets
            .iter_mut()
            .find(|m| m.id == market_id)
            .ok_or(PerpsError::NoMarket)?;
        m.mark = price;
        m.mark_block = block;
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
        let mut st = self.state.borrow_mut();
        st.perp_reserve += amount;
        Ok(st.perp_reserve)
    }

    /// Open an isolated-margin position. Escrows `margin` of the collateral token
    /// (requires a prior `approve`); notional = margin * leverage at the mark.
    #[export]
    pub async fn open_position(
        &mut self,
        market_id: u64,
        is_long: bool,
        margin: u128,
        leverage: u32,
    ) -> Result<u64, PerpsError> {
        if margin == 0 {
            return Err(PerpsError::BadParams);
        }
        if leverage == 0 || leverage > MAX_LEVERAGE {
            return Err(PerpsError::LeverageTooHigh);
        }
        let (collateral, entry, caller) = {
            let st = self.state.borrow();
            if st.perp_positions.len() >= MAX_POSITIONS {
                return Err(PerpsError::BookFull);
            }
            (st.perp_collateral, fresh_mark(&st, market_id)?, msg::source())
        };
        if collateral == ActorId::zero() {
            return Err(PerpsError::NoCollateral);
        }
        // Escrow the margin before recording anything.
        if !vft_transfer_from(collateral, caller, margin).await {
            return Err(PerpsError::TransferFailed);
        }
        let mut st = self.state.borrow_mut();
        let notional = margin * leverage as u128;
        // Trading fee (charged on notional, taken from the posted margin).
        let open_fee = notional * FEE_BPS / 10_000;
        if margin <= open_fee {
            return Err(PerpsError::InsufficientMargin);
        }
        // Open-interest cap: bound the reserve's directional exposure per side.
        {
            let m = st
                .perp_markets
                .iter()
                .find(|m| m.id == market_id)
                .ok_or(PerpsError::NoMarket)?;
            let side_oi = if is_long { m.long_oi } else { m.short_oi };
            if side_oi.saturating_add(notional) > m.max_oi {
                return Err(PerpsError::OiCapExceeded);
            }
        }
        st.perp_reserve += open_fee; // fee revenue to the house reserve
        if let Some(m) = st.perp_markets.iter_mut().find(|m| m.id == market_id) {
            if is_long {
                m.long_oi += notional;
            } else {
                m.short_oi += notional;
            }
        }
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
        });
        Ok(id)
    }

    /// Close your position at the current mark, settling PnL against the reserve and
    /// crediting the payout to your claimable collateral (withdraw via `Spot/Withdraw`).
    #[export]
    pub fn close_position(&mut self, position_id: u64) -> Result<(u128, i128), PerpsError> {
        let caller = msg::source();
        let mut st = self.state.borrow_mut();
        let idx = st
            .perp_positions
            .iter()
            .position(|p| p.id == position_id && p.owner == caller)
            .ok_or(PerpsError::PositionNotFound)?;
        let mark = fresh_mark(&st, st.perp_positions[idx].market_id)?;
        let pos = st.perp_positions[idx].clone();
        let pnl = pnl_of(&pos, mark);
        let (payout, reserve_delta) = settle(pos.margin, pnl, st.perp_reserve);
        st.perp_reserve = (st.perp_reserve as i128 + reserve_delta) as u128;
        // Close fee (on notional), taken from the payout, accrues to the reserve.
        let close_fee = (pos.notional * FEE_BPS / 10_000).min(payout);
        let net_payout = payout - close_fee;
        st.perp_reserve += close_fee;
        // Release the position's open interest.
        if let Some(m) = st.perp_markets.iter_mut().find(|m| m.id == pos.market_id) {
            if pos.is_long {
                m.long_oi = m.long_oi.saturating_sub(pos.notional);
            } else {
                m.short_oi = m.short_oi.saturating_sub(pos.notional);
            }
        }
        let collateral = st.perp_collateral;
        st.credit(caller, collateral, net_payout);
        st.perp_positions.remove(idx);
        Ok((net_payout, pnl))
    }

    /// Permissionless liquidation once equity falls to maintenance margin. The
    /// liquidator earns a fee from residual equity; the rest is settled to the owner.
    #[export]
    pub fn liquidate(&mut self, position_id: u64) -> Result<(), PerpsError> {
        let liquidator = msg::source();
        let mut st = self.state.borrow_mut();
        let idx = st
            .perp_positions
            .iter()
            .position(|p| p.id == position_id)
            .ok_or(PerpsError::PositionNotFound)?;
        let mark = fresh_mark(&st, st.perp_positions[idx].market_id)?;
        let pos = st.perp_positions[idx].clone();
        let pnl = pnl_of(&pos, mark);
        let equity = pos.margin as i128 + pnl;
        let maintenance = (pos.notional * MAINTENANCE_BPS / 10_000) as i128;
        if equity > maintenance {
            return Err(PerpsError::NotLiquidatable);
        }
        let eq_pos = equity.max(0) as u128;
        let fee = eq_pos.min(pos.margin * LIQUIDATION_FEE_BPS / 10_000);
        let to_owner = eq_pos - fee;
        // Whatever the margin didn't cover flows into the reserve.
        st.perp_reserve = (st.perp_reserve as i128 + pos.margin as i128 - eq_pos as i128) as u128;
        // Release the position's open interest.
        if let Some(m) = st.perp_markets.iter_mut().find(|m| m.id == pos.market_id) {
            if pos.is_long {
                m.long_oi = m.long_oi.saturating_sub(pos.notional);
            } else {
                m.short_oi = m.short_oi.saturating_sub(pos.notional);
            }
        }
        let collateral = st.perp_collateral;
        st.credit(pos.owner, collateral, to_owner);
        if fee > 0 {
            st.credit(liquidator, collateral, fee);
        }
        st.perp_positions.remove(idx);
        Ok(())
    }

    /// Admin: withdraw reserve profit (fees + net trader losses) to the admin's
    /// claimable collateral. The operator is responsible for leaving enough to cover
    /// open positions — withdraw profit, not the whole book.
    #[export]
    pub fn withdraw_reserve(&mut self, amount: u128) -> Result<u128, PerpsError> {
        self.require_admin()?;
        let mut st = self.state.borrow_mut();
        if amount == 0 || amount > st.perp_reserve {
            return Err(PerpsError::BadParams);
        }
        st.perp_reserve -= amount;
        let (admin, collateral) = (st.admin, st.perp_collateral);
        st.credit(admin, collateral, amount);
        Ok(st.perp_reserve)
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

    /// A trader's open positions with PnL at the current mark:
    /// `(id, market_id, is_long, notional, entry, margin, leverage, pnl)`.
    #[export]
    pub fn get_positions(&self, owner: ActorId) -> Vec<(u64, u64, bool, u128, u128, u128, u32, i128)> {
        let st = self.state.borrow();
        st.perp_positions
            .iter()
            .filter(|p| p.owner == owner)
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
