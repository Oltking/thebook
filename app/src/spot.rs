//! v1 mainnet spot CLOB — real VFT-token escrow over curated TOKEN/quote pairs.
//!
//! This module is the ground-up rewrite for mainnet (see docs/spot-contract-design.md).
//! It is deliberately self-contained and does NOT touch the legacy virtual-balance
//! services in `orderbook.rs`/`perps.rs`/`amm.rs`, which stay in place until this path
//! is complete and the old one is retired.
//!
//! Model: non-custodial. The DEX only ever holds (a) tokens escrowed by a live order and
//! (b) proceeds credited to a claimable balance the user withdraws on demand. Both are
//! backed 1:1 by tokens the program actually holds. Settlement is synchronous internal
//! accounting (Serum-style claimable balances); async cross-program VFT calls are confined
//! to `place_*` (one `transfer_from` in) and `withdraw` (one `transfer` out).

use crate::types::{RawPayload, SailsReply, Side};
use sails_rs::cell::RefCell;
use sails_rs::collections::BTreeMap;
use sails_rs::gstd::{exec, msg};
use sails_rs::prelude::*;
use sails_rs::scale_codec::{Decode, Encode};

extern crate alloc;
use alloc::vec::Vec;

/// Max resting orders across all pairs — a hard bound so the book can't grow unbounded.
pub const MAX_OPEN_ORDERS: usize = 10_000;

// ── Errors ──────────────────────────────────────────────────────────────────────────
#[derive(Encode, Decode, TypeInfo, Clone, Copy, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum SpotError {
    /// Caller is not the admin/multisig.
    NotAdmin,
    /// Zero price/qty, unknown token, or other malformed input.
    BadParams,
    /// A pair with the same (base, quote) already exists.
    PairExists,
    /// No pair with that id.
    NoPair,
    /// Pair exists but is delisted; no new orders accepted.
    PairInactive,
    /// The global order cap is reached.
    BookFull,
    /// No order with that id.
    NoOrder,
    /// Caller does not own that order.
    NotOwner,
    /// Nothing to withdraw for that token.
    NothingToClaim,
    /// The on-chain VFT transfer failed (bad allowance/balance, or program error).
    TransferFailed,
}

// ── Data model ──────────────────────────────────────────────────────────────────────
#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct SpotPair {
    pub id: u64,
    /// Base token program (the asset being bought/sold).
    pub base: ActorId,
    /// Quote token program (USDT or USDC).
    pub quote: ActorId,
    /// Declared decimals of each token, read from the VFT at listing time.
    pub base_dec: u8,
    pub quote_dec: u8,
    /// Delisted pairs reject new orders but still allow cancel/withdraw.
    pub active: bool,
}

#[derive(Encode, Decode, TypeInfo, Clone, Copy, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum SpotStatus {
    Open,
    PartiallyFilled,
    Filled,
    Cancelled,
}

#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct SpotOrder {
    pub id: u64,
    pub pair_id: u64,
    pub trader: ActorId,
    pub side: Side,
    /// Quote smallest-units per one whole base token (per 10^base_dec base units).
    pub price: u128,
    /// Order size in base token smallest units.
    pub qty: u128,
    /// Filled base amount so far.
    pub filled: u128,
    pub status: SpotStatus,
}

#[derive(Default)]
pub struct SpotState {
    /// Admin / listing authority (the multisig on mainnet). Set at program init.
    pub admin: ActorId,
    pub pairs: Vec<SpotPair>,
    pub next_pair_id: u64,
    pub orders: Vec<SpotOrder>,
    pub next_oid: u64,
    /// Withdrawable proceeds, keyed by (user, token program). Backed 1:1 by held tokens.
    pub claims: BTreeMap<(ActorId, ActorId), u128>,
}

impl SpotState {
    pub fn credit(&mut self, who: ActorId, token: ActorId, amount: u128) {
        if amount == 0 {
            return;
        }
        *self.claims.entry((who, token)).or_insert(0) += amount;
    }
}

/// Quote smallest-units for `qty` base units at `price` (quote per 10^base_dec base):
/// `price * qty / 10^base_dec`. u128 throughout; `U256`-grade widening lands with the
/// async settlement work if arbitrary decimals prove to overflow u128 in practice.
pub fn notional(price: u128, qty: u128, base_dec: u8) -> u128 {
    let scale = 10u128.pow(base_dec as u32);
    (price.saturating_mul(qty)) / scale
}

// ── Service ─────────────────────────────────────────────────────────────────────────
pub struct SpotService<'a> {
    state: &'a RefCell<SpotState>,
}

impl<'a> SpotService<'a> {
    pub fn new(state: &'a RefCell<SpotState>) -> Self {
        Self { state }
    }

    fn require_admin(&self) -> Result<(), SpotError> {
        if msg::source() == self.state.borrow().admin {
            Ok(())
        } else {
            Err(SpotError::NotAdmin)
        }
    }

    /// Resolve a listed, active pair to `(base, quote, base_dec)`.
    fn active_pair(&self, pair_id: u64) -> Result<(ActorId, ActorId, u8), SpotError> {
        let st = self.state.borrow();
        let pair = st
            .pairs
            .iter()
            .find(|p| p.id == pair_id)
            .ok_or(SpotError::NoPair)?;
        if !pair.active {
            return Err(SpotError::PairInactive);
        }
        Ok((pair.base, pair.quote, pair.base_dec))
    }
}

/// Indices of resting orders a taker on `taker` side would cross, best price first
/// (time as tie-break). `limit == None` means a market order (no price bound).
fn crossing_indices(st: &SpotState, pair_id: u64, taker: Side, limit: Option<u128>) -> Vec<usize> {
    let mut idxs: Vec<usize> = st
        .orders
        .iter()
        .enumerate()
        .filter(|(_, o)| {
            o.pair_id == pair_id
                && o.side != taker
                && o.status != SpotStatus::Filled
                && o.status != SpotStatus::Cancelled
                && o.filled < o.qty
                && match (taker, limit) {
                    (Side::Buy, Some(p)) => o.price <= p,
                    (Side::Sell, Some(p)) => o.price >= p,
                    (_, None) => true,
                }
        })
        .map(|(i, _)| i)
        .collect();
    idxs.sort_by(|&a, &b| {
        let (oa, ob) = (&st.orders[a], &st.orders[b]);
        match taker {
            // Taker buy: cheapest ask first. Taker sell: highest bid first.
            Side::Buy => oa.price.cmp(&ob.price).then(oa.id.cmp(&ob.id)),
            Side::Sell => ob.price.cmp(&oa.price).then(oa.id.cmp(&ob.id)),
        }
    });
    idxs
}

#[sails_rs::service]
impl<'a> SpotService<'a> {
    /// Curate a new TOKEN/quote market. Admin-only (multisig on mainnet). `base_dec`
    /// and `quote_dec` are the tokens' declared decimals; the caller supplies them so
    /// listing stays synchronous (they are verifiable against each VFT's metadata).
    #[export]
    pub fn list_pair(
        &mut self,
        base: ActorId,
        quote: ActorId,
        base_dec: u8,
        quote_dec: u8,
    ) -> Result<u64, SpotError> {
        self.require_admin()?;
        if base == ActorId::zero() || quote == ActorId::zero() || base == quote {
            return Err(SpotError::BadParams);
        }
        let mut st = self.state.borrow_mut();
        if st
            .pairs
            .iter()
            .any(|p| p.base == base && p.quote == quote)
        {
            return Err(SpotError::PairExists);
        }
        let id = st.next_pair_id;
        st.next_pair_id += 1;
        st.pairs.push(SpotPair {
            id,
            base,
            quote,
            base_dec,
            quote_dec,
            active: true,
        });
        Ok(id)
    }

    /// Stop accepting new orders on a pair. Existing orders can still be cancelled and
    /// proceeds withdrawn. Admin-only.
    #[export]
    pub fn delist_pair(&mut self, pair_id: u64) -> Result<(), SpotError> {
        self.require_admin()?;
        let mut st = self.state.borrow_mut();
        let pair = st
            .pairs
            .iter_mut()
            .find(|p| p.id == pair_id)
            .ok_or(SpotError::NoPair)?;
        pair.active = false;
        Ok(())
    }

    // ── Reads ──
    #[export]
    pub fn get_pairs(&self) -> Vec<SpotPair> {
        self.state.borrow().pairs.clone()
    }

    #[export]
    pub fn get_pair(&self, pair_id: u64) -> Option<SpotPair> {
        self.state
            .borrow()
            .pairs
            .iter()
            .find(|p| p.id == pair_id)
            .cloned()
    }

    /// Aggregated resting depth for a pair: (bids desc by price, asks asc by price),
    /// each level `(price, remaining_qty)`.
    #[export]
    pub fn get_orderbook(&self, pair_id: u64) -> (Vec<(u128, u128)>, Vec<(u128, u128)>) {
        let st = self.state.borrow();
        let mut bids: BTreeMap<u128, u128> = BTreeMap::new();
        let mut asks: BTreeMap<u128, u128> = BTreeMap::new();
        for o in st.orders.iter().filter(|o| {
            o.pair_id == pair_id
                && o.status != SpotStatus::Filled
                && o.status != SpotStatus::Cancelled
        }) {
            let rem = o.qty - o.filled;
            if rem == 0 {
                continue;
            }
            match o.side {
                Side::Buy => *bids.entry(o.price).or_insert(0) += rem,
                Side::Sell => *asks.entry(o.price).or_insert(0) += rem,
            }
        }
        let bids: Vec<(u128, u128)> = bids.into_iter().rev().collect();
        let asks: Vec<(u128, u128)> = asks.into_iter().collect();
        (bids, asks)
    }

    /// The caller's open/closed orders.
    #[export]
    pub fn get_my_orders(&self) -> Vec<SpotOrder> {
        let caller = msg::source();
        self.state
            .borrow()
            .orders
            .iter()
            .filter(|o| o.trader == caller)
            .cloned()
            .collect()
    }

    /// The caller's withdrawable balance for a given token program.
    #[export]
    pub fn get_claim(&self, token: ActorId) -> u128 {
        let caller = msg::source();
        *self
            .state
            .borrow()
            .claims
            .get(&(caller, token))
            .unwrap_or(&0)
    }

    /// Place a limit order. Escrows the caller's real tokens (a quote-token
    /// `TransferFrom` for a buy, base-token for a sell — requires a prior `approve`),
    /// then crosses the book by price-time priority, crediting fills to claimable
    /// balances. Any unfilled remainder rests. Reverts with no state change if the
    /// escrow transfer fails.
    #[export]
    pub async fn place_limit(
        &mut self,
        pair_id: u64,
        side: Side,
        price: u128,
        qty: u128,
    ) -> Result<u64, SpotError> {
        if price == 0 || qty == 0 {
            return Err(SpotError::BadParams);
        }
        let caller = msg::source();
        // Snapshot the pair and compute escrow without holding a borrow across the await.
        let (base, quote, base_dec, escrow_token, escrow_amt) = {
            let st = self.state.borrow();
            if st.orders.len() >= MAX_OPEN_ORDERS {
                return Err(SpotError::BookFull);
            }
            let pair = st
                .pairs
                .iter()
                .find(|p| p.id == pair_id)
                .ok_or(SpotError::NoPair)?;
            if !pair.active {
                return Err(SpotError::PairInactive);
            }
            let amt = match side {
                Side::Buy => notional(price, qty, pair.base_dec),
                Side::Sell => qty,
            };
            let tok = match side {
                Side::Buy => pair.quote,
                Side::Sell => pair.base,
            };
            (pair.base, pair.quote, pair.base_dec, tok, amt)
        };
        if escrow_amt == 0 {
            return Err(SpotError::BadParams);
        }
        // Pull the escrow in. Reject before touching the book if it fails.
        if !vft_transfer_from(escrow_token, caller, escrow_amt).await {
            return Err(SpotError::TransferFailed);
        }

        let mut st = self.state.borrow_mut();
        let oid = st.next_oid;
        st.next_oid += 1;
        let mut rem = qty;

        // Crossing resting orders, best price first, time (id) as tie-break.
        for mi in crossing_indices(&st, pair_id, side, Some(price)) {
            if rem == 0 {
                break;
            }
            let (o_price, o_avail, o_trader) = {
                let o = &st.orders[mi];
                (o.price, o.qty - o.filled, o.trader)
            };
            let fill = rem.min(o_avail);
            if fill == 0 {
                continue;
            }
            let p_match = o_price;
            let (buyer, seller) = if side == Side::Buy {
                (caller, o_trader)
            } else {
                (o_trader, caller)
            };
            // Buyer receives base; seller receives quote at the resting price.
            st.credit(buyer, base, fill);
            st.credit(seller, quote, notional(p_match, fill, base_dec));
            // A taker buyer escrowed at their (higher) limit; refund the difference.
            if side == Side::Buy && price > p_match {
                st.credit(buyer, quote, notional(price - p_match, fill, base_dec));
            }
            {
                let o = &mut st.orders[mi];
                o.filled += fill;
                o.status = if o.filled >= o.qty {
                    SpotStatus::Filled
                } else {
                    SpotStatus::PartiallyFilled
                };
            }
            rem -= fill;
        }

        // Record the order; the unfilled remainder (if any) rests with its escrow intact.
        let filled = qty - rem;
        let status = if rem == 0 {
            SpotStatus::Filled
        } else if filled == 0 {
            SpotStatus::Open
        } else {
            SpotStatus::PartiallyFilled
        };
        st.orders.push(SpotOrder {
            id: oid,
            pair_id,
            trader: caller,
            side,
            price,
            qty,
            filled,
            status,
        });
        Ok(oid)
    }

    /// Cancel an open order and refund its unfilled escrow to the caller's claimable
    /// balance (quote for a buy, base for a sell).
    #[export]
    pub fn cancel_order(&mut self, order_id: u64) -> Result<(), SpotError> {
        let caller = msg::source();
        let mut st = self.state.borrow_mut();
        let pos = st
            .orders
            .iter()
            .position(|o| o.id == order_id)
            .ok_or(SpotError::NoOrder)?;
        let (trader, side, price, unfilled, pair_id, status) = {
            let o = &st.orders[pos];
            (o.trader, o.side, o.price, o.qty - o.filled, o.pair_id, o.status)
        };
        if trader != caller {
            return Err(SpotError::NotOwner);
        }
        if status == SpotStatus::Filled || status == SpotStatus::Cancelled {
            return Err(SpotError::NoOrder);
        }
        let (refund_token, refund_amt) = {
            let pair = st
                .pairs
                .iter()
                .find(|p| p.id == pair_id)
                .ok_or(SpotError::NoPair)?;
            match side {
                Side::Buy => (pair.quote, notional(price, unfilled, pair.base_dec)),
                Side::Sell => (pair.base, unfilled),
            }
        };
        st.orders[pos].status = SpotStatus::Cancelled;
        st.credit(caller, refund_token, refund_amt);
        Ok(())
    }

    /// Withdraw the caller's full claimable balance of `token` to their wallet. Debits
    /// optimistically and restores the claim if the on-chain transfer fails.
    #[export]
    pub async fn withdraw(&mut self, token: ActorId) -> Result<u128, SpotError> {
        let caller = msg::source();
        let amount = {
            let mut st = self.state.borrow_mut();
            let amount = *st.claims.get(&(caller, token)).unwrap_or(&0);
            if amount == 0 {
                return Err(SpotError::NothingToClaim);
            }
            st.claims.remove(&(caller, token));
            amount
        };
        if !vft_transfer(token, caller, amount).await {
            let mut st = self.state.borrow_mut();
            *st.claims.entry((caller, token)).or_insert(0) += amount;
            return Err(SpotError::TransferFailed);
        }
        Ok(amount)
    }

    /// Market buy up to `qty` base, spending at most `max_quote` quote tokens. Escrows
    /// the full budget up front, sweeps the asks cheapest-first, and refunds anything
    /// unspent (including the whole budget if the book is empty) to the caller's claim.
    /// Never rests. Requires a prior `approve` of `max_quote` on the quote token.
    #[export]
    pub async fn market_buy(
        &mut self,
        pair_id: u64,
        qty: u128,
        max_quote: u128,
    ) -> Result<u64, SpotError> {
        if qty == 0 || max_quote == 0 {
            return Err(SpotError::BadParams);
        }
        let caller = msg::source();
        let (base, quote, base_dec) = self.active_pair(pair_id)?;
        if !vft_transfer_from(quote, caller, max_quote).await {
            return Err(SpotError::TransferFailed);
        }
        let scale = 10u128.pow(base_dec as u32);
        let mut st = self.state.borrow_mut();
        let oid = st.next_oid;
        st.next_oid += 1;
        let mut rem = qty;
        let mut spent = 0u128;
        for mi in crossing_indices(&st, pair_id, Side::Buy, None) {
            if rem == 0 {
                break;
            }
            let (o_price, o_avail, o_trader) = {
                let o = &st.orders[mi];
                (o.price, o.qty - o.filled, o.trader)
            };
            let mut fill = rem.min(o_avail);
            let mut cost = notional(o_price, fill, base_dec);
            if spent + cost > max_quote {
                // Cap the fill to what the remaining budget can afford at this price.
                let budget = max_quote - spent;
                let affordable = budget.saturating_mul(scale) / o_price;
                fill = fill.min(affordable);
                if fill == 0 {
                    break;
                }
                cost = notional(o_price, fill, base_dec);
            }
            st.credit(caller, base, fill);
            st.credit(o_trader, quote, cost);
            spent += cost;
            {
                let o = &mut st.orders[mi];
                o.filled += fill;
                o.status = if o.filled >= o.qty {
                    SpotStatus::Filled
                } else {
                    SpotStatus::PartiallyFilled
                };
            }
            rem -= fill;
        }
        // Refund the unspent budget; a market order never rests.
        st.credit(caller, quote, max_quote - spent);
        st.orders.push(SpotOrder {
            id: oid,
            pair_id,
            trader: caller,
            side: Side::Buy,
            price: 0, // 0 = market order (never rests, excluded from the book)
            qty,
            filled: qty - rem,
            status: SpotStatus::Filled,
        });
        Ok(oid)
    }

    /// Market sell `qty` base into the bids, highest-first. Escrows the base up front,
    /// credits quote proceeds, and refunds any unfilled base to the caller's claim.
    /// Never rests. Requires a prior `approve` of `qty` on the base token.
    #[export]
    pub async fn market_sell(&mut self, pair_id: u128, qty: u128) -> Result<u64, SpotError> {
        if qty == 0 {
            return Err(SpotError::BadParams);
        }
        let pair_id = pair_id as u64;
        let caller = msg::source();
        let (base, quote, base_dec) = self.active_pair(pair_id)?;
        if !vft_transfer_from(base, caller, qty).await {
            return Err(SpotError::TransferFailed);
        }
        let mut st = self.state.borrow_mut();
        let oid = st.next_oid;
        st.next_oid += 1;
        let mut rem = qty;
        for mi in crossing_indices(&st, pair_id, Side::Sell, None) {
            if rem == 0 {
                break;
            }
            let (o_price, o_avail, o_trader) = {
                let o = &st.orders[mi];
                (o.price, o.qty - o.filled, o.trader)
            };
            let fill = rem.min(o_avail);
            if fill == 0 {
                continue;
            }
            st.credit(caller, quote, notional(o_price, fill, base_dec));
            st.credit(o_trader, base, fill);
            {
                let o = &mut st.orders[mi];
                o.filled += fill;
                o.status = if o.filled >= o.qty {
                    SpotStatus::Filled
                } else {
                    SpotStatus::PartiallyFilled
                };
            }
            rem -= fill;
        }
        // Refund whatever couldn't be sold.
        st.credit(caller, base, rem);
        st.orders.push(SpotOrder {
            id: oid,
            pair_id,
            trader: caller,
            side: Side::Sell,
            price: 0,
            qty,
            filled: qty - rem,
            status: SpotStatus::Filled,
        });
        Ok(oid)
    }

    /// Hand listing/admin authority to a new account (the multisig on mainnet).
    /// Admin-only; irreversible except by the new admin.
    #[export]
    pub fn transfer_admin(&mut self, new_admin: ActorId) -> Result<(), SpotError> {
        self.require_admin()?;
        if new_admin == ActorId::zero() {
            return Err(SpotError::BadParams);
        }
        self.state.borrow_mut().admin = new_admin;
        Ok(())
    }
}

/// Build the SCALE route payload for a `Vft` service method call (mirrors the proven
/// helper in `orderbook.rs`). Used by the async escrow/settlement path.
pub fn vft_route(method: &str, args: Vec<u8>) -> Vec<u8> {
    let mut payload = "Vft".encode();
    payload.extend(method.encode());
    payload.extend(args);
    payload
}

/// Move `value` of `token` from `from` into the DEX via VFT `TransferFrom`. Requires a
/// prior `approve`. Returns whether the on-chain transfer succeeded.
pub async fn vft_transfer_from(token: ActorId, from: ActorId, value: u128) -> bool {
    let dex = exec::program_id();
    let payload = vft_route("TransferFrom", (from, dex, U256::from(value)).encode());
    let gas = exec::gas_available() / 2;
    match msg::send_for_reply_as::<RawPayload, SailsReply<bool>>(
        token,
        RawPayload(payload),
        gas as u128,
        0,
    ) {
        Ok(fut) => fut.await.map(|r| r.0).unwrap_or(false),
        Err(_) => false,
    }
}

/// Transfer `value` of `token` from the DEX vault to `to` via VFT `Transfer`.
pub async fn vft_transfer(token: ActorId, to: ActorId, value: u128) -> bool {
    let payload = vft_route("Transfer", (to, U256::from(value)).encode());
    let gas = exec::gas_available() / 2;
    match msg::send_for_reply_as::<RawPayload, SailsReply<bool>>(
        token,
        RawPayload(payload),
        gas as u128,
        0,
    ) {
        Ok(fut) => fut.await.map(|r| r.0).unwrap_or(false),
        Err(_) => false,
    }
}
