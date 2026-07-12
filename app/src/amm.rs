use crate::state::DexState;
use crate::types::*;
use sails_rs::cell::RefCell;
use sails_rs::gstd::msg;
use sails_rs::prelude::*;

extern crate alloc;
use alloc::vec::Vec;

#[sails_rs::event]
#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum AmmEvent {
    PoolCreated(PoolCreatedEvent),
    LiquidityAdded(LiquidityAddedEvent),
    LiquidityRemoved(LiquidityRemovedEvent),
    SwapExecuted(SwapExecutedEvent),
}

pub struct AmmService<'a> {
    state: &'a RefCell<DexState>,
}

impl<'a> AmmService<'a> {
    pub fn new(state: &'a RefCell<DexState>) -> Self {
        Self { state }
    }
}

/// Integer square root via Newton's method, computed in u128 and overflow-safe
/// (never forms `r * r`, which would trap for large inputs under overflow-checks).
fn sqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    let mut x = n;
    let mut y = x.div_ceil(2);
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

fn mod_agent_asset(ag: &mut Agent, asset: Asset, qty: u64, add: bool) {
    match asset {
        Asset::BTC => {
            if add {
                ag.btc += qty
            } else {
                ag.btc -= qty
            }
        }
        Asset::ETH => {
            if add {
                ag.eth += qty
            } else {
                ag.eth -= qty
            }
        }
        Asset::VARA => {
            if add {
                ag.vara += qty
            } else {
                ag.vara -= qty
            }
        }
    }
}

fn agent_asset_bal(ag: &Agent, asset: Asset) -> u64 {
    match asset {
        Asset::BTC => ag.btc,
        Asset::ETH => ag.eth,
        Asset::VARA => ag.vara,
    }
}

#[sails_rs::service(events = AmmEvent)]
impl<'a> AmmService<'a> {
    #[export]
    pub fn create_pool(&mut self, asset_a: Asset, asset_b: Asset) -> Result<PoolId, ContractError> {
        if asset_a == asset_b {
            return Err(ContractError::SameAssetPool);
        }
        let caller = msg::source();
        let mut st = self.state.borrow_mut();

        for pool in st.pools.values() {
            let same_pair = (pool.asset_a == asset_a && pool.asset_b == asset_b)
                || (pool.asset_a == asset_b && pool.asset_b == asset_a);
            if same_pair {
                return Err(ContractError::PoolExists);
            }
        }

        let pid = st.next_pid;
        st.next_pid += 1;

        st.pools.insert(
            pid,
            Pool {
                id: pid,
                asset_a,
                asset_b,
                reserve_a: 0,
                reserve_b: 0,
                total_lp: 0,
                creator: caller,
            },
        );

        self.emit_event(AmmEvent::PoolCreated(PoolCreatedEvent {
            pool_id: pid,
            asset_a,
            asset_b,
            creator: caller,
        }))
        .expect("emit PoolCreated failed");

        Ok(pid)
    }

    #[export]
    pub fn add_liquidity(
        &mut self,
        pool_id: PoolId,
        amount_a: u64,
        amount_b: u64,
    ) -> Result<LpAmount, ContractError> {
        if amount_a == 0 || amount_b == 0 {
            return Err(ContractError::ZeroAmount);
        }
        let caller = msg::source();
        let mut st = self.state.borrow_mut();

        let pool = st
            .pools
            .get(&pool_id)
            .cloned()
            .ok_or(ContractError::PoolNotFound)?;
        let ag = st
            .agents
            .get(&caller)
            .cloned()
            .ok_or(ContractError::JoinFirst)?;

        if agent_asset_bal(&ag, pool.asset_a) < amount_a
            || agent_asset_bal(&ag, pool.asset_b) < amount_b
        {
            return Err(ContractError::InsufficientAsset);
        }

        // Compute LP to mint in u128 to avoid overflow on amount * total_lp.
        let lp_minted: u64 = if pool.total_lp == 0 {
            sqrt(amount_a as u128 * amount_b as u128) as u64
        } else {
            let share_a = amount_a as u128 * pool.total_lp as u128 / pool.reserve_a as u128;
            let share_b = amount_b as u128 * pool.total_lp as u128 / pool.reserve_b as u128;
            share_a.min(share_b) as u64
        };

        if lp_minted == 0 {
            return Err(ContractError::ZeroAmount);
        }

        // Now apply mutations
        let ag = st.agents.get_mut(&caller).unwrap();
        mod_agent_asset(ag, pool.asset_a, amount_a, false);
        mod_agent_asset(ag, pool.asset_b, amount_b, false);

        let pool = st.pools.get_mut(&pool_id).unwrap();
        pool.reserve_a += amount_a;
        pool.reserve_b += amount_b;
        pool.total_lp += lp_minted;

        // Merge into the provider's existing position for this pool instead of
        // pushing a duplicate (remove_liquidity only matches the first entry).
        if let Some(existing) = st
            .lp_positions
            .iter_mut()
            .find(|p| p.pool_id == pool_id && p.provider == caller)
        {
            existing.amount += lp_minted;
            existing.share_a += amount_a;
            existing.share_b += amount_b;
        } else {
            st.lp_positions.push(LpPosition {
                pool_id,
                provider: caller,
                amount: lp_minted,
                share_a: amount_a,
                share_b: amount_b,
            });
        }

        self.emit_event(AmmEvent::LiquidityAdded(LiquidityAddedEvent {
            pool_id,
            provider: caller,
            amount_a,
            amount_b,
            lp_minted,
        }))
        .expect("emit LiquidityAdded failed");

        Ok(lp_minted)
    }

    #[export]
    pub fn remove_liquidity(
        &mut self,
        pool_id: PoolId,
        lp_amount: LpAmount,
    ) -> Result<(u64, u64), ContractError> {
        if lp_amount == 0 {
            return Err(ContractError::ZeroAmount);
        }
        let caller = msg::source();
        let mut st = self.state.borrow_mut();

        let pool = st
            .pools
            .get(&pool_id)
            .cloned()
            .ok_or(ContractError::PoolNotFound)?;

        let pos_idx = st
            .lp_positions
            .iter()
            .position(|p| p.pool_id == pool_id && p.provider == caller)
            .ok_or(ContractError::InsufficientLiquidity)?;

        if st.lp_positions[pos_idx].amount < lp_amount {
            return Err(ContractError::InsufficientLiquidity);
        }

        let amount_a = (pool.reserve_a as u128 * lp_amount as u128 / pool.total_lp as u128) as u64;
        let amount_b = (pool.reserve_b as u128 * lp_amount as u128 / pool.total_lp as u128) as u64;

        if amount_a == 0 || amount_b == 0 {
            return Err(ContractError::ZeroAmount);
        }

        // Apply mutations
        let ag = st.agents.get_mut(&caller).ok_or(ContractError::JoinFirst)?;
        mod_agent_asset(ag, pool.asset_a, amount_a, true);
        mod_agent_asset(ag, pool.asset_b, amount_b, true);

        let pool = st.pools.get_mut(&pool_id).unwrap();
        pool.reserve_a -= amount_a;
        pool.reserve_b -= amount_b;
        pool.total_lp -= lp_amount;

        // Reduce the recorded position proportionally; drop it once fully withdrawn.
        let pos = &mut st.lp_positions[pos_idx];
        let prev_amount = pos.amount;
        pos.share_a =
            (pos.share_a as u128 * (prev_amount - lp_amount) as u128 / prev_amount as u128) as u64;
        pos.share_b =
            (pos.share_b as u128 * (prev_amount - lp_amount) as u128 / prev_amount as u128) as u64;
        pos.amount -= lp_amount;
        if pos.amount == 0 {
            st.lp_positions.remove(pos_idx);
        }

        self.emit_event(AmmEvent::LiquidityRemoved(LiquidityRemovedEvent {
            pool_id,
            provider: caller,
            amount_a,
            amount_b,
            lp_burned: lp_amount,
        }))
        .expect("emit LiquidityRemoved failed");

        Ok((amount_a, amount_b))
    }

    #[export]
    pub fn swap(
        &mut self,
        pool_id: PoolId,
        asset_in: Asset,
        amount_in: u64,
        min_amount_out: u64,
    ) -> Result<u64, ContractError> {
        if amount_in == 0 {
            return Err(ContractError::ZeroAmount);
        }
        let caller = msg::source();
        let mut st = self.state.borrow_mut();

        let pool = st
            .pools
            .get(&pool_id)
            .cloned()
            .ok_or(ContractError::PoolNotFound)?;

        let (reserve_in, reserve_out, asset_out) = if asset_in == pool.asset_a {
            (pool.reserve_a, pool.reserve_b, pool.asset_b)
        } else if asset_in == pool.asset_b {
            (pool.reserve_b, pool.reserve_a, pool.asset_a)
        } else {
            return Err(ContractError::BadParams);
        };

        if reserve_in == 0 || reserve_out == 0 {
            return Err(ContractError::InsufficientLiquidity);
        }

        let ag = st
            .agents
            .get(&caller)
            .cloned()
            .ok_or(ContractError::JoinFirst)?;
        if agent_asset_bal(&ag, asset_in) < amount_in {
            return Err(ContractError::InsufficientAsset);
        }

        let fee = amount_in * SWAP_FEE_NUM / SWAP_FEE_DEN;
        let amount_in_after_fee = amount_in - fee;

        let amount_out = (reserve_out as u128 * amount_in_after_fee as u128
            / (reserve_in as u128 + amount_in_after_fee as u128)) as u64;

        if amount_out < min_amount_out {
            return Err(ContractError::SlippageExceeded);
        }
        if amount_out == 0 {
            return Err(ContractError::ZeroAmount);
        }

        // Apply mutations
        let ag = st.agents.get_mut(&caller).unwrap();
        mod_agent_asset(ag, asset_in, amount_in, false);
        mod_agent_asset(ag, asset_out, amount_out, true);

        // The trader pays the full `amount_in`; `amount_out` is priced off the
        // post-fee input, but the WHOLE input stays in the reserve. That leaves the
        // fee in the pool (raising k), which is how LPs actually earn it on withdrawal.
        // Adding only `amount_in_after_fee` here would destroy the fee instead.
        let pool = st.pools.get_mut(&pool_id).unwrap();
        if asset_in == pool.asset_a {
            pool.reserve_a += amount_in;
            pool.reserve_b -= amount_out;
        } else {
            pool.reserve_b += amount_in;
            pool.reserve_a -= amount_out;
        }

        self.emit_event(AmmEvent::SwapExecuted(SwapExecutedEvent {
            pool_id,
            trader: caller,
            asset_in,
            amount_in,
            asset_out,
            amount_out,
            fee,
        }))
        .expect("emit SwapExecuted failed");

        Ok(amount_out)
    }

    #[export]
    pub fn get_pool(&self, pool_id: PoolId) -> Option<Pool> {
        let st = self.state.borrow();
        st.pools.get(&pool_id).cloned()
    }

    #[export]
    pub fn list_pools(&self) -> Vec<Pool> {
        let st = self.state.borrow();
        st.pools.values().cloned().collect()
    }

    #[export]
    pub fn get_lp_position(&self, pool_id: PoolId, provider: ActorId) -> Option<LpPosition> {
        let st = self.state.borrow();
        st.lp_positions
            .iter()
            .find(|p| p.pool_id == pool_id && p.provider == provider)
            .cloned()
    }
}
