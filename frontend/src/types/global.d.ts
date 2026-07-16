import { ActorId } from 'sails-js';

declare global {
  export type ContractError = "NotAuthorized" | "NotAdmin" | "BadParams" | "JoinFirst" | "InsufficientUsd" | "InsufficientAsset" | "OrderNotFound" | "OrderAlreadyDone" | "NoLiquidity" | "NoBuyers" | "PoolExists" | "PoolNotFound" | "SameAssetPool" | "InsufficientLiquidity" | "SlippageExceeded" | "ZeroAmount" | "AgentCallFailed" | "BookFull";

  // Off-chain price snapshot (sourced from Binance/CoinGecko, not the contract).
  export interface PriceFeed {
    symbol: string;
    price_usd_micro: number | string | bigint;
    change_24h_bps: number;
    market_cap_usd: number | string | bigint;
    volume_24h_usd: number | string | bigint;
    updated_at_block: number;
  }

  export type Asset = "BTC" | "ETH" | "VARA";

  export type TokenKind = "Usd" | "Btc" | "Eth" | "Vara";

  export type Side = "Buy" | "Sell";

  export type AgentStrategy = "ArbitrageHunter" | "MarketMaker" | "Momentum";

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
}
