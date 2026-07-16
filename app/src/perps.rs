use crate::state::DexState;
use crate::types::*;
use sails_rs::cell::RefCell;
use sails_rs::gstd::msg;
use sails_rs::prelude::*;
use sails_rs::scale_codec::{Decode, Encode};

extern crate alloc;
use alloc::vec::Vec;

#[sails_rs::event]
#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum PerpsEvent {
    MarkPrice(MarkPriceEvent),
    Opened(PerpOpenedEvent),
    Closed(PerpClosedEvent),
}

/// Signed PnL of a position at `mark`, in USD cents.
/// long:  size * (mark - entry) / ASSET_UNIT
/// short: size * (entry - mark) / ASSET_UNIT
fn pnl_of(pos: &Position, mark: u64) -> i128 {
    let diff = mark as i128 - pos.entry as i128;
    let signed = if pos.is_long { diff } else { -diff };
    (pos.size as i128 * signed) / ASSET_UNIT as i128
}

/// Current notional (USD cents) = size * mark / ASSET_UNIT.
fn notional_of(size: u64, mark: u64) -> u128 {
    (size as u128 * mark as u128) / ASSET_UNIT as u128
}

pub struct PerpsService<'a> {
    state: &'a RefCell<DexState>,
}

impl<'a> PerpsService<'a> {
    pub fn new(state: &'a RefCell<DexState>) -> Self {
        Self { state }
    }
}

#[sails_rs::service(events = PerpsEvent)]
impl<'a> PerpsService<'a> {
    /// Keeper-only: publish the mark price (USD cents) for an asset. This is the
    /// price PnL and liquidations settle at — like GMX/Pyth keepers pushing a feed.
    #[export]
    pub fn set_mark_price(&mut self, asset: Asset, price: u64) -> Result<(), ContractError> {
        let mut st = self.state.borrow_mut();
        if msg::source() != st.admin {
            return Err(ContractError::NotAdmin);
        }
        st.mark_prices.insert(asset, price);
        self.emit_event(PerpsEvent::MarkPrice(MarkPriceEvent { asset, price }))
            .expect("emit MarkPrice failed");
        Ok(())
    }

    /// Keeper convenience: push all three marks at once (BTC, ETH, VARA), each in
    /// USD cents. A zero leaves that asset's mark unchanged.
    #[export]
    pub fn set_mark_prices(&mut self, btc: u64, eth: u64, vara: u64) -> Result<(), ContractError> {
        let mut st = self.state.borrow_mut();
        if msg::source() != st.admin {
            return Err(ContractError::NotAdmin);
        }
        for (asset, price) in [(Asset::BTC, btc), (Asset::ETH, eth), (Asset::VARA, vara)] {
            if price > 0 {
                st.mark_prices.insert(asset, price);
                self.emit_event(PerpsEvent::MarkPrice(MarkPriceEvent { asset, price }))
                    .expect("emit MarkPrice failed");
            }
        }
        Ok(())
    }

    #[export]
    pub fn get_mark_price(&self, asset: Asset) -> u64 {
        self.state
            .borrow()
            .mark_prices
            .get(&asset)
            .copied()
            .unwrap_or(0)
    }

    #[export]
    pub fn get_mark_prices(&self) -> (u64, u64, u64) {
        let st = self.state.borrow();
        let g = |a: Asset| st.mark_prices.get(&a).copied().unwrap_or(0);
        (g(Asset::BTC), g(Asset::ETH), g(Asset::VARA))
    }

    /// Admin: move USD (cents) from your own balance into the house reserve that
    /// pays trader profits. Never mints — total custodied USD is unchanged.
    #[export]
    pub fn fund_reserve(&mut self, amount: u64) -> Result<u64, ContractError> {
        let caller = msg::source();
        let mut st = self.state.borrow_mut();
        if caller != st.admin {
            return Err(ContractError::NotAdmin);
        }
        if amount == 0 {
            return Err(ContractError::ZeroAmount);
        }
        let ag = st.agents.get_mut(&caller).ok_or(ContractError::JoinFirst)?;
        if ag.usd < amount {
            return Err(ContractError::InsufficientUsd);
        }
        ag.usd -= amount;
        st.reserve_usd += amount;
        Ok(st.reserve_usd)
    }

    #[export]
    pub fn get_reserve(&self) -> u64 {
        self.state.borrow().reserve_usd
    }

    /// Open (or add to) an isolated-margin perpetual position. Locks `margin` USD
    /// cents from your balance; position size = margin * leverage at the mark price.
    #[export]
    pub fn open_position(
        &mut self,
        asset: Asset,
        is_long: bool,
        margin: u64,
        leverage: u32,
    ) -> Result<u64, ContractError> {
        if margin == 0 {
            return Err(ContractError::ZeroAmount);
        }
        if leverage == 0 || leverage > MAX_LEVERAGE {
            return Err(ContractError::LeverageTooHigh);
        }
        let caller = msg::source();
        let mut st = self.state.borrow_mut();

        let mark = st.mark_prices.get(&asset).copied().unwrap_or(0);
        if mark == 0 {
            return Err(ContractError::NoMarkPrice);
        }

        let ag = st.agents.get(&caller).ok_or(ContractError::JoinFirst)?;
        if ag.usd < margin {
            return Err(ContractError::InsufficientUsd);
        }

        // size (asset units) = notional / mark, notional = margin * leverage (cents).
        let notional = margin as u128 * leverage as u128;
        let size = ((notional * ASSET_UNIT as u128) / mark as u128) as u64;
        if size == 0 {
            return Err(ContractError::BadParams);
        }

        let idx = st
            .positions
            .iter()
            .position(|p| p.owner == caller && p.asset == asset);

        match idx {
            Some(i) => {
                if st.positions[i].is_long != is_long {
                    return Err(ContractError::WrongDirection);
                }
                let p = &mut st.positions[i];
                // Size-weighted average entry across the merged position.
                let new_size = p.size + size;
                let blended = (p.entry as u128 * p.size as u128 + mark as u128 * size as u128)
                    / new_size as u128;
                p.size = new_size;
                p.entry = blended as u64;
                p.margin += margin;
                p.leverage = leverage;
            }
            None => {
                if st.positions.len() >= MAX_PERP_POSITIONS {
                    return Err(ContractError::BookFull);
                }
                st.positions.push(Position {
                    owner: caller,
                    asset,
                    is_long,
                    size,
                    entry: mark,
                    margin,
                    leverage,
                });
            }
        }

        st.agents.get_mut(&caller).unwrap().usd -= margin;

        self.emit_event(PerpsEvent::Opened(PerpOpenedEvent {
            owner: caller,
            asset,
            is_long,
            size,
            entry: mark,
            margin,
            leverage,
        }))
        .expect("emit Opened failed");

        Ok(size)
    }

    /// Close your whole position at the current mark price, settling PnL against the
    /// house reserve. Returns `(payout_cents, pnl_cents_signed)`.
    #[export]
    pub fn close_position(&mut self, asset: Asset) -> Result<(u64, i64), ContractError> {
        let caller = msg::source();
        let mut st = self.state.borrow_mut();
        let mark = st.mark_prices.get(&asset).copied().unwrap_or(0);
        if mark == 0 {
            return Err(ContractError::NoMarkPrice);
        }
        let i = st
            .positions
            .iter()
            .position(|p| p.owner == caller && p.asset == asset)
            .ok_or(ContractError::PositionNotFound)?;

        let pos = st.positions[i].clone();
        let pnl = pnl_of(&pos, mark);
        let (payout, reserve_delta) = settle(pos.margin, pnl, st.reserve_usd);

        st.reserve_usd = (st.reserve_usd as i128 + reserve_delta) as u64;
        if let Some(ag) = st.agents.get_mut(&caller) {
            ag.usd += payout;
        }
        st.positions.remove(i);

        self.emit_event(PerpsEvent::Closed(PerpClosedEvent {
            owner: caller,
            asset,
            exit: mark,
            payout,
            pnl: pnl as i64,
            liquidated: false,
        }))
        .expect("emit Closed failed");

        Ok((payout, pnl as i64))
    }

    /// Permissionless liquidation: if a position's equity has fallen to the
    /// maintenance margin, anyone may close it at the mark. The liquidator earns a
    /// small fee from the residual equity; the rest flows to the reserve.
    #[export]
    pub fn liquidate(&mut self, owner: ActorId, asset: Asset) -> Result<(), ContractError> {
        let liquidator = msg::source();
        let mut st = self.state.borrow_mut();
        let mark = st.mark_prices.get(&asset).copied().unwrap_or(0);
        if mark == 0 {
            return Err(ContractError::NoMarkPrice);
        }
        let i = st
            .positions
            .iter()
            .position(|p| p.owner == owner && p.asset == asset)
            .ok_or(ContractError::PositionNotFound)?;

        let pos = st.positions[i].clone();
        let pnl = pnl_of(&pos, mark);
        let equity = pos.margin as i128 + pnl;
        let maintenance = (notional_of(pos.size, mark) * MAINTENANCE_BPS as u128 / 10_000) as i128;
        if equity > maintenance {
            return Err(ContractError::NotLiquidatable);
        }

        // Residual equity (≥0) is split: a liquidator fee, the rest to the owner.
        // Whatever the owner's margin didn't cover flows into the reserve.
        let eq_pos = equity.max(0) as u64;
        let fee = eq_pos.min(pos.margin * LIQUIDATION_FEE_BPS / 10_000);
        let to_owner = eq_pos - fee;

        st.reserve_usd = (st.reserve_usd as i128 + pos.margin as i128 - eq_pos as i128) as u64;
        if let Some(ag) = st.agents.get_mut(&owner) {
            ag.usd += to_owner;
        }
        if fee > 0 {
            if let Some(ag) = st.agents.get_mut(&liquidator) {
                ag.usd += fee;
            } else {
                st.reserve_usd += fee;
            }
        }
        st.positions.remove(i);

        self.emit_event(PerpsEvent::Closed(PerpClosedEvent {
            owner,
            asset,
            exit: mark,
            payout: to_owner,
            pnl: pnl as i64,
            liquidated: true,
        }))
        .expect("emit Closed failed");

        Ok(())
    }

    /// A trader's open positions as
    /// `(asset, is_long, size, entry, margin, leverage, pnl_at_mark)`.
    #[export]
    pub fn get_positions(&self, owner: ActorId) -> Vec<(Asset, bool, u64, u64, u64, u32, i64)> {
        let st = self.state.borrow();
        st.positions
            .iter()
            .filter(|p| p.owner == owner)
            .map(|p| {
                let mark = st.mark_prices.get(&p.asset).copied().unwrap_or(p.entry);
                (
                    p.asset,
                    p.is_long,
                    p.size,
                    p.entry,
                    p.margin,
                    p.leverage,
                    pnl_of(p, mark) as i64,
                )
            })
            .collect()
    }

    /// Liquidation price (USD cents) for a position, i.e. the mark at which equity
    /// hits maintenance margin. 0 if there is no such position.
    #[export]
    pub fn get_liq_price(&self, owner: ActorId, asset: Asset) -> u64 {
        let st = self.state.borrow();
        let Some(p) = st
            .positions
            .iter()
            .find(|p| p.owner == owner && p.asset == asset)
        else {
            return 0;
        };
        liq_price(p)
    }
}

/// Settle a closing position against the reserve.
/// Returns `(payout_to_trader, reserve_delta)`. Payout is capped at
/// `margin + reserve` so the reserve can never go negative.
fn settle(margin: u64, pnl: i128, reserve: u64) -> (u64, i128) {
    let equity = margin as i128 + pnl;
    let cap = margin as i128 + reserve as i128;
    let payout = equity.clamp(0, cap) as u64;
    let reserve_delta = margin as i128 - payout as i128;
    (payout, reserve_delta)
}

/// Mark price (USD cents) at which `pos` reaches maintenance margin.
/// Solve equity = maintenance for `mark`:
///   long:  margin + size*(m-entry)/U = size*m*mm/U
///   short: margin + size*(entry-m)/U = size*m*mm/U
fn liq_price(pos: &Position) -> u64 {
    let u = ASSET_UNIT as i128;
    let size = pos.size as i128;
    let margin = pos.margin as i128;
    let entry = pos.entry as i128;
    let mm = MAINTENANCE_BPS as i128; // per 10_000
    if size == 0 {
        return 0;
    }
    // long:  margin*U + size*(m - entry) = size*m*mm/10000
    //        m * (size - size*mm/10000) = size*entry - margin*U
    // short: margin*U - size*(m - entry) = size*m*mm/10000
    //        m * (size + size*mm/10000) = size*entry + margin*U
    let size_mm = size * mm / 10_000;
    let (num, den) = if pos.is_long {
        (size * entry - margin * u, size - size_mm)
    } else {
        (size * entry + margin * u, size + size_mm)
    };
    if den <= 0 {
        return 0;
    }
    let m = num / den;
    if m < 0 { 0 } else { m as u64 }
}
