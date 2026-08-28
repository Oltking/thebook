//! v1 mainnet spot CLOB — real VFT-token escrow over curated TOKEN/quote pairs.
//!
//! Model: non-custodial. The DEX only ever holds (a) tokens escrowed by a resting
//! order and (b) proceeds credited to a claimable balance the user withdraws on
//! demand. Settlement is synchronous internal accounting (Serum-style claimable
//! balances); async cross-program VFT calls are confined to `place_*`/`open_position`
//! (one `transfer_from` in) and `withdraw` (one `transfer` out).
//!
//! ## Solvency invariant
//!
//! For every token `t` the program holds:
//!
//! ```text
//! balance_of(t) >= sum(claims[_, t]) + escrow(t) + reserve(t) + dust(t)
//! ```
//!
//! where `escrow(t)` is the unreleased escrow of every resting order denominated in
//! `t`. Rounding always floors in the contract's favour, so the relation is an
//! inequality; `dust` accounts for the difference exactly, which lets a monitor
//! assert equality rather than "greater than, probably fine" (audit M-06).
//!
//! ## Post-escrow rule
//!
//! After a successful `transfer_from`, the only legal exits are success or
//! credit-and-return. A Sails `Err` is an ordinary reply, not a trap, and the token
//! program has already committed its transfer in a separate message — so returning
//! an error without crediting the escrow keeps the user's money (audit C-03). Every
//! validation that can be done before the await is done before the await.

use crate::types::{RawPayload, SailsReply, Side};
use sails_rs::cell::RefCell;
use sails_rs::collections::BTreeMap;
use sails_rs::gstd::{exec, msg};
use sails_rs::prelude::*;
use sails_rs::scale_codec::{Decode, Encode};

extern crate alloc;
use alloc::collections::VecDeque;
use alloc::vec::Vec;

/// Max *resting* orders across all pairs. Filled and cancelled orders are removed
/// from state, so this bounds live state rather than lifetime usage (audit H-02).
pub const MAX_OPEN_ORDERS: usize = 10_000;

/// Max rows any paginated read will return, so a read can't grow past the gas limit
/// as state grows (audit L-05).
pub const MAX_PAGE: u32 = 200;

// ── Errors ──────────────────────────────────────────────────────────────────────────
#[derive(Encode, Decode, TypeInfo, Clone, Copy, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum SpotError {
    /// Caller is not the admin/multisig.
    NotAdmin,
    /// Zero price/qty, unknown token, or other malformed input.
    BadParams,
    /// A pair with the same (base, quote) already exists — in either orientation.
    PairExists,
    /// No pair with that id.
    NoPair,
    /// Pair exists but is delisted; no new orders accepted.
    PairInactive,
    /// The global resting-order cap is reached.
    BookFull,
    /// No order with that id.
    NoOrder,
    /// Caller does not own that order.
    NotOwner,
    /// Nothing to withdraw for that token.
    NothingToClaim,
    /// The on-chain VFT transfer failed (bad allowance/balance, or program error).
    TransferFailed,
    /// Trading is paused. Cancel and withdraw remain open.
    Paused,
    /// The fill would be worse than the caller's stated slippage bound.
    SlippageExceeded,
    /// An amount overflowed u128. Trapping beats a silently wrong number.
    Overflow,
    /// The token's on-chain decimals do not match the value supplied at listing.
    DecimalsMismatch,
    /// No pending admin, or the caller is not the pending admin.
    NotPendingAdmin,
}

// ── Events (audit M-02) ─────────────────────────────────────────────────────────────
/// Every state change on the money path emits one of these. They are the audit
/// trail: filled and cancelled orders are removed from state, so history lives here
/// and in indexers, not in an ever-growing vector.
#[sails_rs::event]
#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum SpotEvent {
    PairListed {
        pair_id: u64,
        base: ActorId,
        quote: ActorId,
        base_dec: u8,
        quote_dec: u8,
    },
    PairDelisted {
        pair_id: u64,
    },
    PairRelisted {
        pair_id: u64,
    },
    OrderPlaced {
        order_id: u64,
        pair_id: u64,
        trader: ActorId,
        side: Side,
        price: u128,
        qty: u128,
    },
    Trade {
        pair_id: u64,
        taker_order: u64,
        maker_order: u64,
        buyer: ActorId,
        seller: ActorId,
        price: u128,
        qty: u128,
    },
    OrderCancelled {
        order_id: u64,
        pair_id: u64,
        trader: ActorId,
        refunded: u128,
    },
    OrderClosed {
        order_id: u64,
        pair_id: u64,
        trader: ActorId,
        filled: u128,
    },
    Withdrawn {
        who: ActorId,
        token: ActorId,
        amount: u128,
    },
    DustSwept {
        token: ActorId,
        amount: u128,
    },
    PausedSet {
        paused: bool,
    },
    AdminProposed {
        pending: ActorId,
    },
    AdminChanged {
        admin: ActorId,
    },
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
    /// Decimals of each token, verified against the VFT's own metadata at listing.
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
    /// Tokens escrowed when the order was placed (quote for a buy, base for a sell).
    pub escrowed: u128,
    /// How much of `escrowed` has been paid out or refunded. The remainder at
    /// removal time is rounding dust (audit M-06).
    pub released: u128,
}

#[derive(Default)]
pub struct SpotState {
    /// Admin / listing authority (the multisig on mainnet). Set at program init.
    pub admin: ActorId,
    /// Proposed next admin; becomes admin only by calling `accept_admin` from that
    /// account, so a mistyped address cannot brick the venue (audit H-05).
    pub pending_admin: ActorId,
    /// Global halt. Blocks new orders and new positions; never blocks cancel or
    /// withdraw, so a pause cannot trap user funds (audit H-08).
    pub paused: bool,
    pub pairs: Vec<SpotPair>,
    pub next_pair_id: u64,
    /// Resting orders only, keyed by id. Removed on fill or cancel (audit H-02).
    pub orders: BTreeMap<u64, SpotOrder>,
    /// Price-level index into `orders`: `(pair_id, side, price) -> ids in time order`.
    /// Matching and book reads walk levels, not every order ever placed.
    pub levels: BTreeMap<(u64, Side, u128), VecDeque<u64>>,
    pub next_oid: u64,
    /// Withdrawable proceeds, keyed by (user, token program). Backed 1:1 by held tokens.
    pub claims: BTreeMap<(ActorId, ActorId), u128>,
    /// Unreleased escrow per token across all resting orders. Part of the solvency
    /// invariant; maintained incrementally so a monitor never has to sum the book.
    pub escrow: BTreeMap<ActorId, u128>,
    /// Accumulated rounding remainder per token, sweepable by the admin.
    pub dust: BTreeMap<ActorId, u128>,

    // ── Perps (cash-settled in the collateral token; PnL flows through `claims`) ──
    /// Settlement/collateral token for perps (the USDT VFT program).
    pub perp_collateral: ActorId,
    /// Account allowed to push mark prices (the keeper).
    pub perp_keeper: ActorId,
    /// Real collateral held as the house reserve that pays trader profit.
    pub perp_reserve: u128,
    pub perp_markets: Vec<crate::perps_spot::PerpMarket>,
    pub next_perp_market: u64,
    pub perp_positions: Vec<crate::perps_spot::PerpPosition>,
    pub next_perp_pos: u64,

    // ── AMM (constant-product pools over the same real VFT tokens) ──
    /// Curated liquidity pools. Reserves are real tokens the program holds, on the
    /// same footing as spot escrow, and are counted by `get_solvency`.
    pub amm_pools: Vec<crate::amm_spot::AmmPool>,
    pub next_pool_id: u64,
    /// LP shares per (provider, pool). A share is a claim on a fraction of the pool,
    /// not a balance of anything withdrawable on its own.
    pub lp_shares: BTreeMap<(ActorId, u64), u128>,
}

impl SpotState {
    pub fn credit(&mut self, who: ActorId, token: ActorId, amount: u128) {
        if amount == 0 {
            return;
        }
        *self.claims.entry((who, token)).or_insert(0) += amount;
    }

    fn escrow_add(&mut self, token: ActorId, amount: u128) {
        if amount == 0 {
            return;
        }
        *self.escrow.entry(token).or_insert(0) += amount;
    }

    fn escrow_sub(&mut self, token: ActorId, amount: u128) {
        if amount == 0 {
            return;
        }
        let e = self.escrow.entry(token).or_insert(0);
        *e = e.saturating_sub(amount);
    }

    /// The token an order's escrow is denominated in.
    fn escrow_token(&self, order: &SpotOrder) -> Option<ActorId> {
        let pair = self.pairs.iter().find(|p| p.id == order.pair_id)?;
        Some(match order.side {
            Side::Buy => pair.quote,
            Side::Sell => pair.base,
        })
    }

    /// Index a resting order at its price level (time priority = insertion order).
    fn level_push(&mut self, order: &SpotOrder) {
        self.levels
            .entry((order.pair_id, order.side, order.price))
            .or_default()
            .push_back(order.id);
    }

    fn level_remove(&mut self, pair_id: u64, side: Side, price: u128, id: u64) {
        let key = (pair_id, side, price);
        let empty = match self.levels.get_mut(&key) {
            Some(q) => {
                q.retain(|&x| x != id);
                q.is_empty()
            }
            None => false,
        };
        if empty {
            self.levels.remove(&key);
        }
    }

    /// Retire a resting order: unindex it, book its unreleased escrow as dust, and
    /// drop it from state. Returns the retired order.
    fn retire(&mut self, id: u64) -> Option<SpotOrder> {
        let order = self.orders.remove(&id)?;
        self.level_remove(order.pair_id, order.side, order.price, id);
        let leftover = order.escrowed.saturating_sub(order.released);
        if leftover > 0
            && let Some(tok) = self.escrow_token(&order)
        {
            self.escrow_sub(tok, leftover);
            *self.dust.entry(tok).or_insert(0) += leftover;
        }
        Some(order)
    }
}

/// Quote smallest-units for `qty` base units at `price` (quote per 10^base_dec base):
/// `price * qty / 10^base_dec`.
///
/// Trapping, not saturating: `saturating_mul` would return `u128::MAX` and then divide
/// it, yielding a plausible-looking but wrong number in the one function every
/// settlement path routes through (audit M-05). Overflow is a caller error, so it
/// surfaces as one.
pub fn notional(price: u128, qty: u128, base_dec: u8) -> Result<u128, SpotError> {
    let scale = 10u128
        .checked_pow(base_dec as u32)
        .ok_or(SpotError::BadParams)?;
    price
        .checked_mul(qty)
        .map(|n| n / scale)
        .ok_or(SpotError::Overflow)
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

    fn require_running(&self) -> Result<(), SpotError> {
        if self.state.borrow().paused {
            Err(SpotError::Paused)
        } else {
            Ok(())
        }
    }
}

/// Ids of resting orders a taker on `taker` side would cross, best price first, time
/// as tie-break. `limit == None` means a market order (no price bound). Orders owned
/// by `exclude` are skipped so a trader cannot wash-trade against themselves
/// (audit L-02).
///
/// Walks the price-level index, so cost scales with levels touched rather than with
/// every order ever placed (audit H-02).
fn crossing_ids(
    st: &SpotState,
    pair_id: u64,
    taker: Side,
    limit: Option<u128>,
    exclude: ActorId,
) -> Vec<u64> {
    let mut out: Vec<u64> = Vec::new();
    let push_level = |ids: &VecDeque<u64>, out: &mut Vec<u64>| {
        for &id in ids.iter() {
            if let Some(o) = st.orders.get(&id)
                && o.trader != exclude
                && o.filled < o.qty
            {
                out.push(id);
            }
        }
    };
    match taker {
        // Taker buy crosses asks, cheapest first, up to the limit price.
        Side::Buy => {
            let hi = limit.unwrap_or(u128::MAX);
            for (_, ids) in st
                .levels
                .range((pair_id, Side::Sell, 0)..=(pair_id, Side::Sell, hi))
            {
                push_level(ids, &mut out);
            }
        }
        // Taker sell crosses bids, highest first, down to the limit price.
        Side::Sell => {
            let lo = limit.unwrap_or(0);
            for (_, ids) in st
                .levels
                .range((pair_id, Side::Buy, lo)..=(pair_id, Side::Buy, u128::MAX))
                .rev()
            {
                push_level(ids, &mut out);
            }
        }
    }
    out
}

/// Clamp a caller-supplied page to `MAX_PAGE` rows.
fn page_bounds(offset: u32, limit: u32) -> (usize, usize) {
    let take = limit.clamp(1, MAX_PAGE) as usize;
    (offset as usize, take)
}

#[sails_rs::service(events = SpotEvent)]
impl<'a> SpotService<'a> {
    // ── Admin ──
    /// Curate a new TOKEN/quote market. Admin-only (multisig on mainnet).
    ///
    /// `base_dec`/`quote_dec` are read back from each token's own `VftMetadata`
    /// service and rejected on mismatch — a wrong value would misprice the entire
    /// market by a power of ten, and self-attestation is not a control (audit M-14).
    #[export]
    pub async fn list_pair(
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
        {
            let st = self.state.borrow();
            // Reject either orientation: the same asset pair listed twice splits
            // liquidity across two books that never cross.
            if st.pairs.iter().any(|p| {
                (p.base == base && p.quote == quote) || (p.base == quote && p.quote == base)
            }) {
                return Err(SpotError::PairExists);
            }
        }
        // Verify decimals against each token before recording anything.
        match vft_decimals(base).await {
            Some(d) if d == base_dec => {}
            Some(_) => return Err(SpotError::DecimalsMismatch),
            None => return Err(SpotError::TransferFailed),
        }
        match vft_decimals(quote).await {
            Some(d) if d == quote_dec => {}
            Some(_) => return Err(SpotError::DecimalsMismatch),
            None => return Err(SpotError::TransferFailed),
        }
        let id = {
            let mut st = self.state.borrow_mut();
            // Re-check after the awaits: another listing could have landed meanwhile.
            if st.pairs.iter().any(|p| {
                (p.base == base && p.quote == quote) || (p.base == quote && p.quote == base)
            }) {
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
            id
        };
        let _ = self.emit_event(SpotEvent::PairListed {
            pair_id: id,
            base,
            quote,
            base_dec,
            quote_dec,
        });
        Ok(id)
    }

    /// Stop accepting new orders on a pair. Existing orders can still be cancelled and
    /// proceeds withdrawn. Reversible with `relist_pair` (audit M-14).
    #[export]
    pub fn delist_pair(&mut self, pair_id: u64) -> Result<(), SpotError> {
        self.require_admin()?;
        self.set_pair_active(pair_id, false)?;
        let _ = self.emit_event(SpotEvent::PairDelisted { pair_id });
        Ok(())
    }

    /// Re-open a delisted pair. Admin-only.
    #[export]
    pub fn relist_pair(&mut self, pair_id: u64) -> Result<(), SpotError> {
        self.require_admin()?;
        self.set_pair_active(pair_id, true)?;
        let _ = self.emit_event(SpotEvent::PairRelisted { pair_id });
        Ok(())
    }

    /// Halt or resume trading. Cancel and withdraw are deliberately never gated on
    /// this, so pausing during an incident cannot trap user funds (audit H-08).
    #[export]
    pub fn set_paused(&mut self, paused: bool) -> Result<(), SpotError> {
        self.require_admin()?;
        self.state.borrow_mut().paused = paused;
        let _ = self.emit_event(SpotEvent::PausedSet { paused });
        Ok(())
    }

    /// Propose a new admin. Takes effect only when that account calls `accept_admin`,
    /// so a typo is recoverable rather than terminal (audit H-05).
    #[export]
    pub fn propose_admin(&mut self, new_admin: ActorId) -> Result<(), SpotError> {
        self.require_admin()?;
        if new_admin == ActorId::zero() {
            return Err(SpotError::BadParams);
        }
        self.state.borrow_mut().pending_admin = new_admin;
        let _ = self.emit_event(SpotEvent::AdminProposed { pending: new_admin });
        Ok(())
    }

    /// Accept a pending admin handover. Callable only by the proposed account.
    #[export]
    pub fn accept_admin(&mut self) -> Result<(), SpotError> {
        let caller = msg::source();
        {
            let mut st = self.state.borrow_mut();
            if st.pending_admin == ActorId::zero() || st.pending_admin != caller {
                return Err(SpotError::NotPendingAdmin);
            }
            st.admin = caller;
            st.pending_admin = ActorId::zero();
        }
        let _ = self.emit_event(SpotEvent::AdminChanged { admin: caller });
        Ok(())
    }

    /// Sweep accumulated rounding dust for a token to the admin's claimable balance.
    /// Dust is real, already-held tokens that no claim references (audit M-06).
    #[export]
    pub fn sweep_dust(&mut self, token: ActorId) -> Result<u128, SpotError> {
        self.require_admin()?;
        let amount = {
            let mut st = self.state.borrow_mut();
            let amount = st.dust.remove(&token).unwrap_or(0);
            if amount == 0 {
                return Err(SpotError::NothingToClaim);
            }
            let admin = st.admin;
            st.credit(admin, token, amount);
            amount
        };
        let _ = self.emit_event(SpotEvent::DustSwept { token, amount });
        Ok(amount)
    }

    // ── Reads ──
    /// Curated markets, paginated (audit L-05).
    #[export]
    pub fn get_pairs(&self, offset: u32, limit: u32) -> Vec<SpotPair> {
        let (skip, take) = page_bounds(offset, limit);
        self.state
            .borrow()
            .pairs
            .iter()
            .skip(skip)
            .take(take)
            .cloned()
            .collect()
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

    #[export]
    pub fn pair_count(&self) -> u64 {
        self.state.borrow().pairs.len() as u64
    }

    /// Aggregated resting depth for a pair: (bids desc by price, asks asc by price),
    /// each level `(price, remaining_qty)`, capped at `depth` levels per side.
    #[export]
    pub fn get_orderbook(
        &self,
        pair_id: u64,
        depth: u32,
    ) -> (Vec<(u128, u128)>, Vec<(u128, u128)>) {
        let st = self.state.borrow();
        let cap = depth.clamp(1, MAX_PAGE) as usize;
        let level_qty = |ids: &VecDeque<u64>| -> u128 {
            ids.iter()
                .filter_map(|id| st.orders.get(id))
                .map(|o| o.qty - o.filled)
                .sum()
        };
        let bids: Vec<(u128, u128)> = st
            .levels
            .range((pair_id, Side::Buy, 0)..=(pair_id, Side::Buy, u128::MAX))
            .rev()
            .map(|((_, _, price), ids)| (*price, level_qty(ids)))
            .filter(|(_, q)| *q > 0)
            .take(cap)
            .collect();
        let asks: Vec<(u128, u128)> = st
            .levels
            .range((pair_id, Side::Sell, 0)..=(pair_id, Side::Sell, u128::MAX))
            .map(|((_, _, price), ids)| (*price, level_qty(ids)))
            .filter(|(_, q)| *q > 0)
            .take(cap)
            .collect();
        (bids, asks)
    }

    /// The caller's resting orders, paginated. Filled and cancelled orders are not
    /// retained in state — their history is in the event log (audit H-02, M-02).
    #[export]
    pub fn get_my_orders(&self, offset: u32, limit: u32) -> Vec<SpotOrder> {
        let caller = msg::source();
        let (skip, take) = page_bounds(offset, limit);
        self.state
            .borrow()
            .orders
            .values()
            .filter(|o| o.trader == caller)
            .skip(skip)
            .take(take)
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

    /// Escrow, dust, and reserve held for a token. With the token's own
    /// `balanceOf(program)` this lets a monitor assert the solvency invariant
    /// without replaying the book (audit M-17).
    #[export]
    pub fn get_solvency(&self, token: ActorId) -> (u128, u128, u128) {
        let st = self.state.borrow();
        let perp = if st.perp_collateral == token {
            st.perp_reserve
        } else {
            0
        };
        // AMM reserves are real tokens this program holds, so they belong on the
        // "owed" side of the invariant. Without them a monitor would read a funded
        // pool as unexplained surplus, and a drained one as still solvent.
        let pooled: u128 = st
            .amm_pools
            .iter()
            .map(|p| {
                (if p.token_a == token { p.reserve_a } else { 0 })
                    .saturating_add(if p.token_b == token { p.reserve_b } else { 0 })
            })
            .fold(0u128, |a, b| a.saturating_add(b));
        (
            *st.escrow.get(&token).unwrap_or(&0),
            *st.dust.get(&token).unwrap_or(&0),
            perp.saturating_add(pooled),
        )
    }

    #[export]
    pub fn is_paused(&self) -> bool {
        self.state.borrow().paused
    }

    #[export]
    pub fn get_admin(&self) -> (ActorId, ActorId) {
        let st = self.state.borrow();
        (st.admin, st.pending_admin)
    }

    #[export]
    pub fn resting_order_count(&self) -> u64 {
        self.state.borrow().orders.len() as u64
    }

    // ── Trading ──
    /// Place a limit order. Escrows the caller's real tokens (a quote-token
    /// `TransferFrom` for a buy, base-token for a sell — requires a prior `approve`),
    /// then crosses the book by price-time priority, crediting fills to claimable
    /// balances. Any unfilled remainder rests.
    ///
    /// Every check that can precede the escrow does; the only post-await failure is
    /// the capacity re-check, which credits the escrow back before returning
    /// (audit C-03, M-08).
    #[export]
    pub async fn place_limit(
        &mut self,
        pair_id: u64,
        side: Side,
        price: u128,
        qty: u128,
    ) -> Result<u64, SpotError> {
        self.require_running()?;
        if price == 0 || qty == 0 {
            return Err(SpotError::BadParams);
        }
        let caller = msg::source();
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
                Side::Buy => notional(price, qty, pair.base_dec)?,
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
        // Pull the escrow in. Everything after this point must either succeed or
        // credit the escrow back to the caller.
        if !vft_transfer_from(escrow_token, caller, escrow_amt).await {
            return Err(SpotError::TransferFailed);
        }

        let mut events: Vec<SpotEvent> = Vec::new();
        let result = {
            let mut st = self.state.borrow_mut();
            // Re-check capacity on the same borrow that inserts: the await above
            // yields, so the pre-check alone is advisory (audit M-08).
            if st.orders.len() >= MAX_OPEN_ORDERS {
                st.credit(caller, escrow_token, escrow_amt);
                return Err(SpotError::BookFull);
            }
            st.escrow_add(escrow_token, escrow_amt);
            let oid = st.next_oid;
            st.next_oid += 1;
            let mut order = SpotOrder {
                id: oid,
                pair_id,
                trader: caller,
                side,
                price,
                qty,
                filled: 0,
                status: SpotStatus::Open,
                escrowed: escrow_amt,
                released: 0,
            };
            let mut rem = qty;

            for mid in crossing_ids(&st, pair_id, side, Some(price), caller) {
                if rem == 0 {
                    break;
                }
                let (o_price, o_avail, o_trader) = match st.orders.get(&mid) {
                    Some(o) => (o.price, o.qty - o.filled, o.trader),
                    None => continue,
                };
                let fill = rem.min(o_avail);
                if fill == 0 {
                    continue;
                }
                let p_match = o_price;
                let proceeds = notional(p_match, fill, base_dec)?;
                let (buyer, seller) = if side == Side::Buy {
                    (caller, o_trader)
                } else {
                    (o_trader, caller)
                };
                // Buyer receives base; seller receives quote at the resting price.
                st.credit(buyer, base, fill);
                st.credit(seller, quote, proceeds);
                // A taker buyer escrowed at their (higher) limit; refund the difference.
                let refund = if side == Side::Buy && price > p_match {
                    let r = notional(price - p_match, fill, base_dec)?;
                    st.credit(buyer, quote, r);
                    r
                } else {
                    0
                };
                // Book the escrow each side released, so the residue is exact dust.
                match side {
                    Side::Buy => {
                        order.released += proceeds + refund;
                        st.escrow_sub(quote, proceeds + refund);
                        if let Some(m) = st.orders.get_mut(&mid) {
                            m.released += fill;
                        }
                        st.escrow_sub(base, fill);
                    }
                    Side::Sell => {
                        order.released += fill;
                        st.escrow_sub(base, fill);
                        if let Some(m) = st.orders.get_mut(&mid) {
                            m.released += proceeds;
                        }
                        st.escrow_sub(quote, proceeds);
                    }
                }
                let maker_done = {
                    let m = st.orders.get_mut(&mid).expect("maker present");
                    m.filled += fill;
                    m.status = SpotStatus::PartiallyFilled;
                    m.filled >= m.qty
                };
                events.push(SpotEvent::Trade {
                    pair_id,
                    taker_order: oid,
                    maker_order: mid,
                    buyer,
                    seller,
                    price: p_match,
                    qty: fill,
                });
                if maker_done && let Some(done) = st.retire(mid) {
                    events.push(SpotEvent::OrderClosed {
                        order_id: mid,
                        pair_id,
                        trader: done.trader,
                        filled: done.filled,
                    });
                }
                rem -= fill;
            }

            order.filled = qty - rem;
            if rem == 0 {
                // Fully filled: never rests, so it is retired immediately and its
                // residual escrow booked as dust.
                let filled = order.filled;
                st.orders.insert(oid, order);
                st.retire(oid);
                events.push(SpotEvent::OrderClosed {
                    order_id: oid,
                    pair_id,
                    trader: caller,
                    filled,
                });
            } else {
                order.status = if order.filled == 0 {
                    SpotStatus::Open
                } else {
                    SpotStatus::PartiallyFilled
                };
                st.level_push(&order);
                st.orders.insert(oid, order);
            }
            oid
        };
        let _ = self.emit_event(SpotEvent::OrderPlaced {
            order_id: result,
            pair_id,
            trader: caller,
            side,
            price,
            qty,
        });
        for e in events {
            let _ = self.emit_event(e);
        }
        Ok(result)
    }

    /// Cancel a resting order and refund its unfilled escrow to the caller's
    /// claimable balance. Never gated on the pause switch.
    #[export]
    pub fn cancel_order(&mut self, order_id: u64) -> Result<(), SpotError> {
        let caller = msg::source();
        let (pair_id, refund_amt) = {
            let mut st = self.state.borrow_mut();
            let order = st.orders.get(&order_id).ok_or(SpotError::NoOrder)?.clone();
            if order.trader != caller {
                return Err(SpotError::NotOwner);
            }
            let unfilled = order.qty - order.filled;
            let pair = st
                .pairs
                .iter()
                .find(|p| p.id == order.pair_id)
                .ok_or(SpotError::NoPair)?;
            let (refund_token, refund_amt) = match order.side {
                Side::Buy => (pair.quote, notional(order.price, unfilled, pair.base_dec)?),
                Side::Sell => (pair.base, unfilled),
            };
            if let Some(o) = st.orders.get_mut(&order_id) {
                o.released += refund_amt;
            }
            st.escrow_sub(refund_token, refund_amt);
            st.credit(caller, refund_token, refund_amt);
            st.retire(order_id);
            (order.pair_id, refund_amt)
        };
        let _ = self.emit_event(SpotEvent::OrderCancelled {
            order_id,
            pair_id,
            trader: caller,
            refunded: refund_amt,
        });
        Ok(())
    }

    /// Withdraw `amount` of the caller's claimable `token` to their wallet, or the
    /// full balance when `amount` is `None` (audit L-01). Debits optimistically and
    /// restores the claim if the on-chain transfer fails. Never gated on the pause.
    #[export]
    pub async fn withdraw(
        &mut self,
        token: ActorId,
        amount: Option<u128>,
    ) -> Result<u128, SpotError> {
        let caller = msg::source();
        let amount = {
            let mut st = self.state.borrow_mut();
            let held = *st.claims.get(&(caller, token)).unwrap_or(&0);
            if held == 0 {
                return Err(SpotError::NothingToClaim);
            }
            let want = amount.unwrap_or(held);
            if want == 0 || want > held {
                return Err(SpotError::BadParams);
            }
            if want == held {
                st.claims.remove(&(caller, token));
            } else {
                st.claims.insert((caller, token), held - want);
            }
            want
        };
        if !vft_transfer(token, caller, amount).await {
            let mut st = self.state.borrow_mut();
            *st.claims.entry((caller, token)).or_insert(0) += amount;
            return Err(SpotError::TransferFailed);
        }
        let _ = self.emit_event(SpotEvent::Withdrawn {
            who: caller,
            token,
            amount,
        });
        Ok(amount)
    }

    /// Market buy up to `qty` base, spending at most `max_quote` quote tokens and
    /// requiring at least `min_base_out` base in return.
    ///
    /// `min_base_out` is the slippage bound (audit H-03): without it a taker sweeps
    /// whatever asks happen to exist, which on a thin book is an invitation to pull
    /// quotes and leave a lowball. When the bound is not met the whole budget is
    /// credited back and nothing is filled.
    #[export]
    pub async fn market_buy(
        &mut self,
        pair_id: u64,
        qty: u128,
        max_quote: u128,
        min_base_out: u128,
    ) -> Result<u64, SpotError> {
        self.require_running()?;
        if qty == 0 || max_quote == 0 || min_base_out > qty {
            return Err(SpotError::BadParams);
        }
        let caller = msg::source();
        let (base, quote, base_dec) = {
            let st = self.state.borrow();
            let pair = st
                .pairs
                .iter()
                .find(|p| p.id == pair_id)
                .ok_or(SpotError::NoPair)?;
            if !pair.active {
                return Err(SpotError::PairInactive);
            }
            (pair.base, pair.quote, pair.base_dec)
        };
        let scale = 10u128
            .checked_pow(base_dec as u32)
            .ok_or(SpotError::BadParams)?;
        if !vft_transfer_from(quote, caller, max_quote).await {
            return Err(SpotError::TransferFailed);
        }

        let mut events: Vec<SpotEvent> = Vec::new();
        let oid = {
            let mut st = self.state.borrow_mut();
            let oid = st.next_oid;
            st.next_oid += 1;
            let mut rem = qty;
            let mut spent = 0u128;
            // Plan the sweep first so the slippage bound can reject before any
            // balance moves — the post-escrow rule forbids a bare error return.
            let mut plan: Vec<(u64, u128, u128, u128)> = Vec::new(); // (maker id, fill, cost, price)
            for mid in crossing_ids(&st, pair_id, Side::Buy, None, caller) {
                if rem == 0 {
                    break;
                }
                let (o_price, o_avail) = match st.orders.get(&mid) {
                    Some(o) => (o.price, o.qty - o.filled),
                    None => continue,
                };
                let mut fill = rem.min(o_avail);
                let mut cost = notional(o_price, fill, base_dec)?;
                if spent + cost > max_quote {
                    let budget = max_quote - spent;
                    let affordable =
                        budget.checked_mul(scale).ok_or(SpotError::Overflow)? / o_price;
                    fill = fill.min(affordable);
                    if fill == 0 {
                        break;
                    }
                    cost = notional(o_price, fill, base_dec)?;
                }
                plan.push((mid, fill, cost, o_price));
                spent += cost;
                rem -= fill;
            }
            let bought = qty - rem;
            if bought < min_base_out {
                // Refund the full budget; the order simply does not happen.
                st.credit(caller, quote, max_quote);
                return Err(SpotError::SlippageExceeded);
            }
            for (mid, fill, cost, o_price) in plan {
                let o_trader = match st.orders.get(&mid) {
                    Some(o) => o.trader,
                    None => continue,
                };
                st.credit(caller, base, fill);
                st.credit(o_trader, quote, cost);
                // The maker here is a resting *sell*: its escrow is base, so `fill`
                // is what it released — not the quote it received.
                if let Some(m) = st.orders.get_mut(&mid) {
                    m.released += fill;
                    m.filled += fill;
                    m.status = SpotStatus::PartiallyFilled;
                }
                st.escrow_sub(base, fill);
                events.push(SpotEvent::Trade {
                    pair_id,
                    taker_order: oid,
                    maker_order: mid,
                    buyer: caller,
                    seller: o_trader,
                    price: o_price,
                    qty: fill,
                });
                let done = st
                    .orders
                    .get(&mid)
                    .map(|m| m.filled >= m.qty)
                    .unwrap_or(false);
                if done && let Some(d) = st.retire(mid) {
                    events.push(SpotEvent::OrderClosed {
                        order_id: mid,
                        pair_id,
                        trader: d.trader,
                        filled: d.filled,
                    });
                }
            }
            // Refund the unspent budget; a market order never rests.
            st.credit(caller, quote, max_quote - spent);
            oid
        };
        for e in events {
            let _ = self.emit_event(e);
        }
        Ok(oid)
    }

    /// Market sell `qty` base into the bids, highest-first, requiring at least
    /// `min_quote_out` quote in return (audit H-03). Escrows the base up front and
    /// refunds everything if the bound is not met.
    #[export]
    pub async fn market_sell(
        &mut self,
        pair_id: u64,
        qty: u128,
        min_quote_out: u128,
    ) -> Result<u64, SpotError> {
        self.require_running()?;
        if qty == 0 {
            return Err(SpotError::BadParams);
        }
        let caller = msg::source();
        let (base, quote, base_dec) = {
            let st = self.state.borrow();
            let pair = st
                .pairs
                .iter()
                .find(|p| p.id == pair_id)
                .ok_or(SpotError::NoPair)?;
            if !pair.active {
                return Err(SpotError::PairInactive);
            }
            (pair.base, pair.quote, pair.base_dec)
        };
        if !vft_transfer_from(base, caller, qty).await {
            return Err(SpotError::TransferFailed);
        }

        let mut events: Vec<SpotEvent> = Vec::new();
        let oid = {
            let mut st = self.state.borrow_mut();
            let oid = st.next_oid;
            st.next_oid += 1;
            let mut rem = qty;
            let mut proceeds_total = 0u128;
            let mut plan: Vec<(u64, u128, u128)> = Vec::new(); // (maker id, fill, proceeds)
            for mid in crossing_ids(&st, pair_id, Side::Sell, None, caller) {
                if rem == 0 {
                    break;
                }
                let (o_price, o_avail) = match st.orders.get(&mid) {
                    Some(o) => (o.price, o.qty - o.filled),
                    None => continue,
                };
                let fill = rem.min(o_avail);
                if fill == 0 {
                    continue;
                }
                let proceeds = notional(o_price, fill, base_dec)?;
                plan.push((mid, fill, proceeds));
                proceeds_total += proceeds;
                rem -= fill;
            }
            if proceeds_total < min_quote_out {
                st.credit(caller, base, qty);
                return Err(SpotError::SlippageExceeded);
            }
            for (mid, fill, proceeds) in plan {
                let (o_trader, o_price) = match st.orders.get(&mid) {
                    Some(o) => (o.trader, o.price),
                    None => continue,
                };
                st.credit(caller, quote, proceeds);
                st.credit(o_trader, base, fill);
                // The maker here is a resting *bid*: its escrow is quote, so
                // `proceeds` is what it released — not the base it received.
                if let Some(m) = st.orders.get_mut(&mid) {
                    m.released += proceeds;
                    m.filled += fill;
                    m.status = SpotStatus::PartiallyFilled;
                }
                st.escrow_sub(quote, proceeds);
                events.push(SpotEvent::Trade {
                    pair_id,
                    taker_order: oid,
                    maker_order: mid,
                    buyer: o_trader,
                    seller: caller,
                    price: o_price,
                    qty: fill,
                });
                let done = st
                    .orders
                    .get(&mid)
                    .map(|m| m.filled >= m.qty)
                    .unwrap_or(false);
                if done && let Some(d) = st.retire(mid) {
                    events.push(SpotEvent::OrderClosed {
                        order_id: mid,
                        pair_id,
                        trader: d.trader,
                        filled: d.filled,
                    });
                }
            }
            // Refund whatever couldn't be sold.
            st.credit(caller, base, rem);
            oid
        };
        for e in events {
            let _ = self.emit_event(e);
        }
        Ok(oid)
    }
}

impl<'a> SpotService<'a> {
    fn set_pair_active(&mut self, pair_id: u64, active: bool) -> Result<(), SpotError> {
        let mut st = self.state.borrow_mut();
        let pair = st
            .pairs
            .iter_mut()
            .find(|p| p.id == pair_id)
            .ok_or(SpotError::NoPair)?;
        pair.active = active;
        Ok(())
    }
}

// ── Cross-program VFT calls ─────────────────────────────────────────────────────────
//
// All three helpers below use `send_with_gas_for_reply_as`, whose parameters are
// `(program, payload, gas_limit, value, reply_deposit)`.
//
// They previously called `send_for_reply_as`, which is
// `(program, payload, value, reply_deposit)` — **no gas parameter at all**. The
// computed gas limit was therefore passed in the `value` slot, so every escrow,
// withdrawal and metadata read tried to attach `gas_available() / 2` *units of native
// VARA* to the message.
//
// In `gtest` the program is funded generously and the available gas is small, so the
// value fit and the tests passed. On a real node `gas_available()` is orders of
// magnitude larger than anything the program holds, so the send failed and the whole
// call trapped — every `place_limit` and `withdraw` on mainnet would have reverted.
//
// Gas is now in the gas slot and `value` is 0, which is correct: these are pure
// message calls and should never transfer native tokens.

/// Gas handed to a single VFT call.
///
/// Previously this was `gas_available() / 2`, which starves any method making more
/// than one cross-program call: the first hands away half the budget, the second
/// gets half of what little remains. A starved call does not fail cleanly — the
/// reply cannot be paid for, so the message sits in the waitlist waiting for a
/// reply that can never arrive, and the caller sees their transaction silently do
/// nothing. `list_pair` (two metadata reads) reproduced exactly that on mainnet.
///
/// Sizing, measured rather than guessed: a full `market_buy` round trip against the
/// real bridged tokens burns about 7.7 billion gas in total, so a single inner call
/// needs only a few billion. The gtest token is heavier (its constructor alone costs
/// 493 billion, since it pre-allocates sharded balance maps) and a 5 billion cap made
/// its `TransferFrom` fail outright. 10 billion clears both with room, while still
/// leaving a two-call method like `add_liquidity` enough budget for its second call
/// and its replies out of a 30 billion transaction limit.
const VFT_CALL_GAS: u64 = 10_000_000_000;

fn vft_call_gas() -> u64 {
    VFT_CALL_GAS.min(exec::gas_available() / 2)
}

/// Build the SCALE route payload for a service method call on a VFT program.
pub fn vft_route(service: &str, method: &str, args: Vec<u8>) -> Vec<u8> {
    let mut payload = service.encode();
    payload.extend(method.encode());
    payload.extend(args);
    payload
}

/// Move `value` of `token` from `from` into the DEX via VFT `TransferFrom`. Requires a
/// prior `approve`. Returns whether the on-chain transfer succeeded.
pub async fn vft_transfer_from(token: ActorId, from: ActorId, value: u128) -> bool {
    let dex = exec::program_id();
    let payload = vft_route(
        "Vft",
        "TransferFrom",
        (from, dex, U256::from(value)).encode(),
    );
    let gas = vft_call_gas();
    match msg::send_with_gas_for_reply_as::<RawPayload, SailsReply<bool>>(
        token,
        RawPayload(payload),
        gas,
        0,
        0,
    ) {
        Ok(fut) => fut.await.map(|r| r.0).unwrap_or(false),
        Err(_) => false,
    }
}

/// Transfer `value` of `token` from the DEX vault to `to` via VFT `Transfer`.
pub async fn vft_transfer(token: ActorId, to: ActorId, value: u128) -> bool {
    let payload = vft_route("Vft", "Transfer", (to, U256::from(value)).encode());
    let gas = vft_call_gas();
    match msg::send_with_gas_for_reply_as::<RawPayload, SailsReply<bool>>(
        token,
        RawPayload(payload),
        gas,
        0,
        0,
    ) {
        Ok(fut) => fut.await.map(|r| r.0).unwrap_or(false),
        Err(_) => false,
    }
}

/// Read a token's declared decimals from its `VftMetadata` service, so a listing can
/// verify what the admin typed instead of trusting it (audit M-14).
pub async fn vft_decimals(token: ActorId) -> Option<u8> {
    let payload = vft_route("VftMetadata", "Decimals", Vec::new());
    let gas = vft_call_gas();
    match msg::send_with_gas_for_reply_as::<RawPayload, SailsReply<u8>>(
        token,
        RawPayload(payload),
        gas,
        0,
        0,
    ) {
        Ok(fut) => fut.await.map(|r| r.0).ok(),
        Err(_) => None,
    }
}

#[cfg(test)]
extern crate std;

#[cfg(test)]
mod tests {
    use super::*;

    fn aid(n: u8) -> ActorId {
        ActorId::from([n; 32])
    }

    fn rest(st: &mut SpotState, id: u64, side: Side, price: u128, qty: u128, trader: ActorId) {
        let o = SpotOrder {
            id,
            pair_id: 0,
            trader,
            side,
            price,
            qty,
            filled: 0,
            status: SpotStatus::Open,
            escrowed: qty,
            released: 0,
        };
        st.level_push(&o);
        st.orders.insert(id, o);
    }

    #[test]
    fn notional_scales_by_base_decimals() {
        // 2 whole base (dec 5 => 200_000 units) at price 3 quote per whole = 6 quote.
        assert_eq!(notional(3, 200_000, 5).unwrap(), 6);
        // Fractional: 0.5 base at price 10 = 5.
        assert_eq!(notional(10, 50_000, 5).unwrap(), 5);
    }

    #[test]
    fn notional_traps_on_overflow_instead_of_saturating() {
        // saturating_mul would return u128::MAX / scale — a plausible wrong number.
        assert_eq!(notional(u128::MAX, 2, 6), Err(SpotError::Overflow));
    }

    #[test]
    fn crossing_prefers_best_price_then_time() {
        let mut st = SpotState::default();
        for (id, price) in [(0u64, 12u128), (1, 10), (2, 10)] {
            rest(&mut st, id, Side::Sell, price, 100, aid(9));
        }
        let ids = crossing_ids(&st, 0, Side::Buy, Some(12), aid(1));
        assert_eq!(ids, std::vec![1, 2, 0]);
    }

    #[test]
    fn crossing_respects_limit_and_side() {
        let mut st = SpotState::default();
        rest(&mut st, 0, Side::Sell, 15, 100, aid(9));
        // Buy limit 10 can't reach an ask at 15.
        assert!(crossing_ids(&st, 0, Side::Buy, Some(10), aid(1)).is_empty());
        // Market buy (no limit) reaches it.
        assert_eq!(crossing_ids(&st, 0, Side::Buy, None, aid(1)).len(), 1);
    }

    #[test]
    fn crossing_excludes_the_callers_own_orders() {
        let mut st = SpotState::default();
        rest(&mut st, 0, Side::Sell, 10, 100, aid(1));
        rest(&mut st, 1, Side::Sell, 10, 100, aid(2));
        // aid(1) may not trade against itself (audit L-02).
        assert_eq!(crossing_ids(&st, 0, Side::Buy, None, aid(1)), std::vec![1]);
    }

    #[test]
    fn retiring_an_order_unindexes_it_and_books_dust() {
        let mut st = SpotState::default();
        st.pairs.push(SpotPair {
            id: 0,
            base: aid(7),
            quote: aid(8),
            base_dec: 6,
            quote_dec: 6,
            active: true,
        });
        rest(&mut st, 0, Side::Sell, 10, 100, aid(1));
        st.escrow_add(aid(7), 100);
        if let Some(o) = st.orders.get_mut(&0) {
            o.released = 97; // 3 units of rounding residue
        }
        st.retire(0);
        assert!(st.orders.is_empty());
        assert!(
            st.levels.is_empty(),
            "level index must not leak removed orders"
        );
        assert_eq!(*st.dust.get(&aid(7)).unwrap(), 3);
        assert_eq!(*st.escrow.get(&aid(7)).unwrap(), 97);
    }

    #[test]
    fn credit_accumulates_per_user_token() {
        let mut st = SpotState::default();
        st.credit(aid(1), aid(2), 100);
        st.credit(aid(1), aid(2), 50);
        st.credit(aid(1), aid(3), 7);
        assert_eq!(*st.claims.get(&(aid(1), aid(2))).unwrap(), 150);
        assert_eq!(*st.claims.get(&(aid(1), aid(3))).unwrap(), 7);
        // Zero credit is a no-op (no phantom entry).
        st.credit(aid(4), aid(2), 0);
        assert!(!st.claims.contains_key(&(aid(4), aid(2))));
    }

    #[test]
    fn page_bounds_caps_at_max_page() {
        assert_eq!(page_bounds(0, u32::MAX), (0, MAX_PAGE as usize));
        assert_eq!(page_bounds(10, 0), (10, 1));
        assert_eq!(page_bounds(5, 20), (5, 20));
    }
}
