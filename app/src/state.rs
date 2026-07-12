use crate::types::*;
use sails_rs::collections::BTreeMap;
use sails_rs::prelude::*;

extern crate alloc;
use alloc::vec::Vec;

#[derive(Default)]
pub struct DexState {
    /// Program deployer; the only account allowed to manage oracle feeds and autopilot.
    pub admin: ActorId,
    pub agents: BTreeMap<ActorId, Agent>,
    pub orders: Vec<Order>,
    pub trades: Vec<TradeInfo>,
    pub next_oid: u64,
    pub next_tid: u64,
    pub total_trades: u64,
    pub oracles: Vec<OracleFeed>,
    pub running: bool,
    pub cycle: u32,
    pub pools: BTreeMap<PoolId, Pool>,
    pub next_pid: PoolId,
    pub lp_positions: Vec<LpPosition>,
}
