import { ActorId } from 'sails-js';

declare global {
  // ── Custom app + VFT globals (not from the thebook IDL; re-added after codegen) ──
  export interface PriceFeed {
    symbol: string;
    price_usd_micro: number | string | bigint;
    change_24h_bps: number;
    market_cap_usd: number | string | bigint;
    volume_24h_usd: number | string | bigint;
    updated_at_block: number;
  }
  export interface Pagination { offset: number; limit: number; }
  export type FaucetError = "AlreadyClaimed" | "MintFailed";

  export type ContractError = "NotAuthorized" | "NotAdmin" | "BadParams" | "JoinFirst" | "InsufficientUsd" | "InsufficientAsset" | "OrderNotFound" | "OrderAlreadyDone" | "NoLiquidity" | "NoBuyers" | "PoolExists" | "PoolNotFound" | "SameAssetPool" | "InsufficientLiquidity" | "SlippageExceeded" | "ZeroAmount" | "AgentCallFailed" | "BookFull" | "NoMarkPrice" | "LeverageTooHigh" | "PositionNotFound" | "WrongDirection" | "NotLiquidatable" | "StaleMark";

  /**
   * The four balances the DEX custodies, each backed by a real VFT on-chain.
   * `Usd` is a separate kind because the orderbook denominates in USD but the
   * `Asset` enum only covers the tradeable tokens (BTC/ETH/VARA).
  */
  export type TokenKind = "Usd" | "Btc" | "Eth" | "Vara";

  /**
   * The trading persona a user picks when creating their agent. Display/behaviour
   * hint today; drives autopilot strategy selection in a later phase.
  */
  export type AgentStrategy = "ArbitrageHunter" | "MarketMaker" | "Momentum";

  export type Asset = "BTC" | "ETH" | "VARA";

  export type Side = "Buy" | "Sell";

  export interface LeaderEntry {
    id: ActorId;
    name: string;
    strategy: AgentStrategy;
    usd: number | string | bigint;
    net_worth: number | string | bigint;
  }

  export type OrderStatus = "Open" | "Partial" | "Filled" | "Cancelled";

  export interface OrderPlacedEvent {
    trader: ActorId;
    side: Side;
    asset: Asset;
    price: number | string | bigint;
    qty: number | string | bigint;
    order_id: number | string | bigint;
  }

  export interface OrderCancelledEvent {
    trader: ActorId;
    order_id: number | string | bigint;
  }

  export interface TradeEvent {
    trade_id: number | string | bigint;
    asset: Asset;
    price: number | string | bigint;
    qty: number | string | bigint;
    buyer: ActorId;
    seller: ActorId;
  }

  export interface LpPosition {
    pool_id: number | string | bigint;
    provider: ActorId;
    amount: number | string | bigint;
    share_a: number | string | bigint;
    share_b: number | string | bigint;
  }

  export interface Pool {
    id: number | string | bigint;
    asset_a: Asset;
    asset_b: Asset;
    reserve_a: number | string | bigint;
    reserve_b: number | string | bigint;
    total_lp: number | string | bigint;
    creator: ActorId;
  }

  export interface PoolCreatedEvent {
    pool_id: number | string | bigint;
    asset_a: Asset;
    asset_b: Asset;
    creator: ActorId;
  }

  export interface LiquidityAddedEvent {
    pool_id: number | string | bigint;
    provider: ActorId;
    amount_a: number | string | bigint;
    amount_b: number | string | bigint;
    lp_minted: number | string | bigint;
  }

  export interface LiquidityRemovedEvent {
    pool_id: number | string | bigint;
    provider: ActorId;
    amount_a: number | string | bigint;
    amount_b: number | string | bigint;
    lp_burned: number | string | bigint;
  }

  export interface SwapExecutedEvent {
    pool_id: number | string | bigint;
    trader: ActorId;
    asset_in: Asset;
    amount_in: number | string | bigint;
    asset_out: Asset;
    amount_out: number | string | bigint;
    fee: number | string | bigint;
  }

  export interface MarkPriceEvent {
    asset: Asset;
    price: number | string | bigint;
  }

  export interface PerpOpenedEvent {
    owner: ActorId;
    asset: Asset;
    is_long: boolean;
    size: number | string | bigint;
    entry: number | string | bigint;
    margin: number | string | bigint;
    leverage: number;
  }

  export interface PerpClosedEvent {
    owner: ActorId;
    asset: Asset;
    exit: number | string | bigint;
    payout: number | string | bigint;
    pnl: number | string | bigint;
    liquidated: boolean;
  }

  export type SpotError = "NotAdmin" | "BadParams" | "PairExists" | "NoPair" | "PairInactive" | "BookFull" | "NoOrder" | "NotOwner" | "NothingToClaim" | "TransferFailed";

  export interface SpotOrder {
    id: number | string | bigint;
    pair_id: number | string | bigint;
    trader: ActorId;
    side: Side;
    /**
     * Quote smallest-units per one whole base token (per 10^base_dec base units).
    */
    price: number | string | bigint;
    /**
     * Order size in base token smallest units.
    */
    qty: number | string | bigint;
    /**
     * Filled base amount so far.
    */
    filled: number | string | bigint;
    status: SpotStatus;
  }

  export type SpotStatus = "Open" | "PartiallyFilled" | "Filled" | "Cancelled";

  export interface SpotPair {
    id: number | string | bigint;
    /**
     * Base token program (the asset being bought/sold).
    */
    base: ActorId;
    /**
     * Quote token program (USDT or USDC).
    */
    quote: ActorId;
    /**
     * Declared decimals of each token, read from the VFT at listing time.
    */
    base_dec: number;
    quote_dec: number;
    /**
     * Delisted pairs reject new orders but still allow cancel/withdraw.
    */
    active: boolean;
  }

  export type PerpsError = "NotAdmin" | "NotKeeper" | "BadParams" | "NoMarket" | "MarketInactive" | "StaleMark" | "LeverageTooHigh" | "InsufficientMargin" | "PositionNotFound" | "NotLiquidatable" | "BookFull" | "TransferFailed" | "NoCollateral" | "OiCapExceeded";

  export interface PerpMarket {
    id: number | string | bigint;
    symbol: string;
    /**
     * Mark price (arbitrary consistent units; PnL uses price ratios so the unit cancels).
    */
    mark: number | string | bigint;
    /**
     * Block the mark was last published.
    */
    mark_block: number;
    active: boolean;
    /**
     * Open interest (sum of position notional) per side — the house's directional
     * exposure. Capped by `max_oi` so the reserve's worst-case loss is bounded.
    */
    long_oi: number | string | bigint;
    short_oi: number | string | bigint;
    /**
     * Max open interest per side (u128::MAX = unlimited until the admin tightens it).
    */
    max_oi: number | string | bigint;
  }
};