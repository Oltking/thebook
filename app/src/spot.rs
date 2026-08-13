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
}

/// Build the SCALE route payload for a `Vft` service method call (mirrors the proven
/// helper in `orderbook.rs`). Used by the async escrow/settlement path.
#[allow(dead_code)]
pub fn vft_route(method: &str, args: Vec<u8>) -> Vec<u8> {
    let mut payload = "Vft".encode();
    payload.extend(method.encode());
    payload.extend(args);
    payload
}

/// Move `value` of `token` from `from` into the DEX via VFT `TransferFrom`. Requires a
/// prior `approve`. Returns whether the on-chain transfer succeeded. (Wired into
/// `place_*` in the next increment.)
#[allow(dead_code)]
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

/// Transfer `value` of `token` from the DEX vault to `to` via VFT `Transfer`. (Wired
/// into `withdraw` in the next increment.)
#[allow(dead_code)]
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
