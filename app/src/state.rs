use crate::types::*;
use sails_rs::collections::BTreeMap;
use sails_rs::prelude::*;

extern crate alloc;
use alloc::vec::Vec;

#[derive(Default)]
pub struct DexState {
    /// Program deployer; the only account allowed to manage autopilot.
    pub admin: ActorId,
    /// Whether the admin has already claimed the one-time house liquidity stockpile.
    pub house_seeded: bool,
    pub agents: BTreeMap<ActorId, Agent>,
    pub orders: Vec<Order>,
    pub trades: Vec<TradeInfo>,
    pub next_oid: u64,
    pub next_tid: u64,
    pub total_trades: u64,
    pub running: bool,
    pub cycle: u32,
    pub pools: BTreeMap<PoolId, Pool>,
    pub next_pid: PoolId,
    pub lp_positions: Vec<LpPosition>,
    /// VFT program IDs backing each custodied balance. Zero (default) means the
    /// token isn't wired up yet, which blocks deposit/withdraw for that kind.
    pub token_usd: ActorId,
    pub token_btc: ActorId,
    pub token_eth: ActorId,
    pub token_vara: ActorId,
    // ── Perpetual futures ──
    /// On-chain mark price per asset, in USD cents, pushed by the keeper.
    pub mark_prices: BTreeMap<Asset, u64>,
    /// Block height at which each asset's mark was last published. Used to reject
    /// perp actions against a stale (keeper-stalled) price.
    pub mark_updated: BTreeMap<Asset, u32>,
    /// Open isolated-margin positions.
    pub positions: Vec<Position>,
    /// House liquidity reserve (USD cents) that pays trader profits and absorbs
    /// losses. Seeded by the admin from their own USD; never minted.
    pub reserve_usd: u64,
}

impl DexState {
    pub fn token_of(&self, kind: TokenKind) -> ActorId {
        match kind {
            TokenKind::Usd => self.token_usd,
            TokenKind::Btc => self.token_btc,
            TokenKind::Eth => self.token_eth,
            TokenKind::Vara => self.token_vara,
        }
    }

    pub fn set_token_of(&mut self, kind: TokenKind, addr: ActorId) {
        match kind {
            TokenKind::Usd => self.token_usd = addr,
            TokenKind::Btc => self.token_btc = addr,
            TokenKind::Eth => self.token_eth = addr,
            TokenKind::Vara => self.token_vara = addr,
        }
    }
}
