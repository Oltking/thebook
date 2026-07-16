use sails_rs::prelude::*;

extern crate alloc;
use alloc::string::String;

/// Wrapper that bypasses SCALE Vec<u8> encoding — sends payload bytes as-is.
/// Sails dispatch uses `load_bytes()` (raw bytes), so we must NOT wrap in SCALE.
pub struct RawPayload(pub Vec<u8>);

impl Encode for RawPayload {
    fn encode(&self) -> Vec<u8> {
        self.0.clone()
    }
    fn size_hint(&self) -> usize {
        self.0.len()
    }
}

/// Decodes a Sails reply that echoes the route before the return value.
/// Sails reply format: SCALE_string(service_name) + SCALE_string(func_name) + SCALE(return_value)
pub struct SailsReply<T: Decode>(pub T);

impl<T: Decode> Decode for SailsReply<T> {
    fn decode<I: sails_rs::scale_codec::Input>(
        input: &mut I,
    ) -> Result<Self, sails_rs::scale_codec::Error> {
        let _ = String::decode(input)?;
        let _ = String::decode(input)?;
        let inner = T::decode(input)?;
        Ok(SailsReply(inner))
    }
}

#[derive(Encode, Decode, TypeInfo, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum Asset {
    BTC,
    ETH,
    VARA,
}

impl Asset {
    pub fn name(&self) -> &'static str {
        match self {
            Asset::BTC => "BTC",
            Asset::ETH => "ETH",
            Asset::VARA => "VARA",
        }
    }
}

/// The four balances the DEX custodies, each backed by a real VFT on-chain.
/// `Usd` is a separate kind because the orderbook denominates in USD but the
/// `Asset` enum only covers the tradeable tokens (BTC/ETH/VARA).
#[derive(Encode, Decode, TypeInfo, Clone, Copy, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum TokenKind {
    Usd,
    Btc,
    Eth,
    Vara,
}

#[derive(Encode, Decode, TypeInfo, Clone, Copy, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum Side {
    Buy,
    Sell,
}

/// The trading persona a user picks when creating their agent. Display/behaviour
/// hint today; drives autopilot strategy selection in a later phase.
#[derive(Encode, Decode, TypeInfo, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum AgentStrategy {
    #[default]
    ArbitrageHunter,
    MarketMaker,
    Momentum,
}

#[derive(Encode, Decode, TypeInfo, Clone, Copy, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum OrderStatus {
    Open,
    Partial,
    Filled,
    Cancelled,
}

#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct Order {
    pub id: u64,
    pub trader: ActorId,
    pub side: Side,
    pub asset: Asset,
    pub price: u64,
    pub qty: u64,
    pub filled: u64,
    pub status: OrderStatus,
}

#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct TradeInfo {
    pub id: u64,
    pub price: u64,
    pub qty: u64,
    pub buyer: ActorId,
    pub seller: ActorId,
    pub asset: Asset,
}

pub type PoolId = u64;
pub type LpAmount = u64;

#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct Pool {
    pub id: PoolId,
    pub asset_a: Asset,
    pub asset_b: Asset,
    pub reserve_a: u64,
    pub reserve_b: u64,
    pub total_lp: LpAmount,
    pub creator: ActorId,
}

#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct LpPosition {
    pub pool_id: PoolId,
    pub provider: ActorId,
    pub amount: LpAmount,
    pub share_a: u64,
    pub share_b: u64,
}

#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct Agent {
    pub id: ActorId,
    pub name: String,
    pub strategy: AgentStrategy,
    pub usd: u64,
    pub btc: u64,
    pub eth: u64,
    pub vara: u64,
}

/// An isolated-margin perpetual position. `size` is in asset units (`ASSET_UNIT`
/// per asset); `entry`/`margin` are in USD cents. PnL is settled at the on-chain
/// mark price against the house reserve, so no balance is minted.
#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct Position {
    pub owner: ActorId,
    pub asset: Asset,
    pub is_long: bool,
    pub size: u64,
    pub entry: u64,
    pub margin: u64,
    pub leverage: u32,
}

#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct PerpOpenedEvent {
    pub owner: ActorId,
    pub asset: Asset,
    pub is_long: bool,
    pub size: u64,
    pub entry: u64,
    pub margin: u64,
    pub leverage: u32,
}

#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct PerpClosedEvent {
    pub owner: ActorId,
    pub asset: Asset,
    pub exit: u64,
    pub payout: u64,
    pub pnl: i64,
    pub liquidated: bool,
}

#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct MarkPriceEvent {
    pub asset: Asset,
    pub price: u64,
}

#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct LeaderEntry {
    pub id: ActorId,
    pub name: String,
    pub strategy: AgentStrategy,
    pub usd: u64,
    pub net_worth: u64,
}

#[derive(Encode, Decode, TypeInfo, Clone, Copy, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum ContractError {
    NotAuthorized,
    NotAdmin,
    BadParams,
    JoinFirst,
    InsufficientUsd,
    InsufficientAsset,
    OrderNotFound,
    OrderAlreadyDone,
    NoLiquidity,
    NoBuyers,
    PoolExists,
    PoolNotFound,
    SameAssetPool,
    InsufficientLiquidity,
    SlippageExceeded,
    ZeroAmount,
    AgentCallFailed,
    BookFull,
    NoMarkPrice,
    LeverageTooHigh,
    PositionNotFound,
    WrongDirection,
    NotLiquidatable,
}

#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct PoolCreatedEvent {
    pub pool_id: PoolId,
    pub asset_a: Asset,
    pub asset_b: Asset,
    pub creator: ActorId,
}

#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct LiquidityAddedEvent {
    pub pool_id: PoolId,
    pub provider: ActorId,
    pub amount_a: u64,
    pub amount_b: u64,
    pub lp_minted: LpAmount,
}

#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct LiquidityRemovedEvent {
    pub pool_id: PoolId,
    pub provider: ActorId,
    pub amount_a: u64,
    pub amount_b: u64,
    pub lp_burned: LpAmount,
}

#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct SwapExecutedEvent {
    pub pool_id: PoolId,
    pub trader: ActorId,
    pub asset_in: Asset,
    pub amount_in: u64,
    pub asset_out: Asset,
    pub amount_out: u64,
    pub fee: u64,
}

#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct OrderPlacedEvent {
    pub trader: ActorId,
    pub side: Side,
    pub asset: Asset,
    pub price: u64,
    pub qty: u64,
    pub order_id: u64,
}

#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct OrderCancelledEvent {
    pub trader: ActorId,
    pub order_id: u64,
}

#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct TradeEvent {
    pub trade_id: u64,
    pub asset: Asset,
    pub price: u64,
    pub qty: u64,
    pub buyer: ActorId,
    pub seller: ActorId,
}

pub const INITIAL_USD: u64 = 100_000;
pub const INITIAL_BTC: u64 = 100_000;
pub const INITIAL_ETH: u64 = 1_000_000;
pub const INITIAL_VARA: u64 = 1_000_000_000;
pub const SWAP_FEE_NUM: u64 = 3;
pub const SWAP_FEE_DEN: u64 = 1_000;
pub const MAX_PAGE: u32 = 50;
/// Max agent name length (bytes). Names are truncated to bound on-chain state.
pub const MAX_NAME_LEN: usize = 24;
/// Cap on retained trade history. Older trades are dropped so on-chain state can't
/// grow without bound; queries only ever read the most recent trades anyway.
pub const MAX_TRADES: usize = 1_000;

// ── Perpetual futures (GMX-style: keeper mark price + house-reserve settlement) ──
/// Asset quantity scale: `1 asset = ASSET_UNIT internal size units` (matches the
/// spot orderbook qty scale). Mark prices and margin are in **USD cents**, the same
/// integer scale as the internal `usd` balance, so PnL math stays exact.
pub const ASSET_UNIT: u64 = 100_000;
/// Highest leverage a position may open at.
pub const MAX_LEVERAGE: u32 = 20;
/// Maintenance margin as bps of current notional. Below this equity → liquidatable.
pub const MAINTENANCE_BPS: u64 = 50;
/// Liquidator reward, in bps of the liquidated position's margin.
pub const LIQUIDATION_FEE_BPS: u64 = 100;
/// Cap on simultaneously-open perp positions across everyone (state-bloat guard).
pub const MAX_PERP_POSITIONS: usize = 500;
/// Cap on simultaneously-resting orders across the whole book. New limit orders are
/// rejected past this so a spammer can't bloat state indefinitely.
pub const MAX_OPEN_ORDERS: usize = 500;
