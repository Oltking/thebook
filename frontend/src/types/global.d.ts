import { ActorId } from 'sails-js';

declare global {
  export type SpotError = "NotAdmin" | "BadParams" | "PairExists" | "NoPair" | "PairInactive" | "BookFull" | "NoOrder" | "NotOwner" | "NothingToClaim" | "TransferFailed" | "Paused" | "SlippageExceeded" | "Overflow" | "DecimalsMismatch" | "NotPendingAdmin";

  /**
   * `Ord` matters: `Side` is part of the spot price-level index key
   * `(pair_id, side, price)`, which is what makes matching walk levels instead of
   * every order ever placed.
  */
  export type Side = "Buy" | "Sell";

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
    /**
     * Tokens escrowed when the order was placed (quote for a buy, base for a sell).
    */
    escrowed: number | string | bigint;
    /**
     * How much of `escrowed` has been paid out or refunded. The remainder at
     * removal time is rounding dust (audit M-06).
    */
    released: number | string | bigint;
  }

  export type SpotStatus = "Open" | "PartiallyFilled";

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
     * Decimals of each token, verified against the VFT's own metadata at listing.
    */
    base_dec: number;
    quote_dec: number;
    /**
     * Delisted pairs reject new orders but still allow cancel/withdraw.
    */
    active: boolean;
  }

  export type PerpsError = "NotAdmin" | "NotKeeper" | "BadParams" | "NoMarket" | "MarketInactive" | "StaleMark" | "LeverageTooHigh" | "InsufficientMargin" | "PositionNotFound" | "NotLiquidatable" | "BookFull" | "TransferFailed" | "NoCollateral" | "OiCapExceeded" | "Paused" | "MarkDeviationTooLarge" | "InsufficientCoverage" | "Overflow";

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
     * Max open interest per side. Required at market creation: there is no
     * unlimited default, because the safe value should not depend on an operator
     * remembering a second call (audit M-03).
    */
    max_oi: number | string | bigint;
    /**
     * Cumulative funding index in `FUNDING_SCALE` units. Rises while longs are the
     * crowded side, falls while shorts are. Longs pay the increase, shorts receive
     * its negation; both settle against the reserve, which is the counterparty.
    */
    cum_funding: number | string | bigint;
    /**
     * Block `cum_funding` was last advanced.
    */
    funding_block: number;
  }

  /* ── Hand-written types ───────────────────────────────────────────────────────
   * Not generated from the IDL. `PriceFeed` and `Asset` describe the off-chain
   * market-data feed, which has no on-chain counterpart — the contract never sees
   * these prices. Keep them below the generated block so regenerating the client
   * does not silently drop them.
   */

  export interface PriceFeed {
    symbol: string;
    price_usd_micro: number | string | bigint;
    change_24h_bps: number;
    market_cap_usd: number | string | bigint;
    volume_24h_usd: number | string | bigint;
    updated_at_block: number;
  }

  /** Assets the off-chain price feed covers. */
  export type Asset = "BTC" | "ETH" | "VARA";

  export interface Pagination { offset: number; limit: number; }
  export type FaucetError = "AlreadyClaimed" | "MintFailed";
};