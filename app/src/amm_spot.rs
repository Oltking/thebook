//! v1 mainnet AMM — constant-product pools over the same real VFT tokens as spot.
//!
//! This replaces the legacy `amm.rs`, which was deleted in the audit remediation. That
//! one swapped *virtual* balances inside a ledger anyone could mint into (finding
//! C-02) and never touched a real token: it contained zero cross-program calls. This
//! one custodies actual tokens.
//!
//! ## How liquidity providers earn
//!
//! `FEE_BPS` is skimmed from the input of every swap **before** the constant-product
//! maths and left in the pool. So `k = reserve_a * reserve_b` grows with each trade,
//! while the number of LP shares does not. A share is a fixed fraction of the pool, so
//! the fraction becomes worth more.
//!
//! There is deliberately no per-LP reward accounting and no claim function: fees
//! cannot drift, be double-claimed, or be forgotten, because they are never tracked
//! separately in the first place. An LP realises them by burning shares.
//!
//! The honest counterpart is impermanent loss. When the price moves, arbitrage
//! rebalances the pool, and a provider can end up with less value than simply holding
//! the two tokens. Fees offset that; they do not always beat it. Said plainly in
//! `docs/risk-disclosure.md`.
//!
//! ## Custody and the post-escrow rule
//!
//! Pool reserves are real tokens held by this program and counted by
//! `Spot/GetSolvency`, so the solvency monitor sees them. `add_liquidity` makes *two*
//! `transfer_from` calls; if the second fails after the first succeeded, the first is
//! credited back to the provider's claimable balance rather than kept. Same rule as
//! spot and perps (audit C-03).

use crate::spot::{SpotError, SpotState, vft_transfer_from};
use sails_rs::cell::RefCell;
use sails_rs::gstd::msg;
use sails_rs::prelude::*;
use sails_rs::scale_codec::{Decode, Encode};

extern crate alloc;
use alloc::vec::Vec;

/// Swap fee, in basis points of the input amount. Kept in the pool, so it accrues to
/// liquidity providers rather than to the protocol.
pub const FEE_BPS: u128 = 30; // 0.3%

/// Shares burned on the first deposit and never redeemable.
///
/// Without this, the first provider can deposit a dust amount, receive nearly all
/// shares, then donate directly to the reserves to inflate the share price and take a
/// disproportionate cut of the next provider's deposit. Locking a small amount of the
/// initial mint makes that attack cost more than it yields. Same reasoning as
/// Uniswap V2's minimum liquidity.
pub const MINIMUM_LIQUIDITY: u128 = 1_000;

/// Max pools, so pool state cannot grow without bound.
pub const MAX_POOLS: usize = 256;

#[derive(Encode, Decode, TypeInfo, Clone, Copy, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum AmmError {
    NotAdmin,
    BadParams,
    /// A pool for this token pair already exists, in either orientation.
    PoolExists,
    NoPool,
    /// Pool exists but is delisted; no new deposits or swaps.
    PoolInactive,
    /// The global pool cap is reached.
    TooManyPools,
    /// The on-chain VFT transfer failed (bad allowance/balance, or program error).
    TransferFailed,
    /// Trading is paused. Removing liquidity remains open.
    Paused,
    /// The result would be worse than the caller's stated bound.
    SlippageExceeded,
    /// Caller does not hold that many shares.
    InsufficientShares,
    /// The deposit or swap is too small to move any reserve.
    AmountTooSmall,
    /// An amount overflowed. Trapping beats a silently wrong number.
    Overflow,
    /// The token's on-chain decimals do not match the value supplied at creation.
    DecimalsMismatch,
}

impl From<SpotError> for AmmError {
    fn from(e: SpotError) -> Self {
        match e {
            SpotError::Overflow => AmmError::Overflow,
            SpotError::Paused => AmmError::Paused,
            SpotError::DecimalsMismatch => AmmError::DecimalsMismatch,
            _ => AmmError::BadParams,
        }
    }
}

// ── Events ──────────────────────────────────────────────────────────────────────────
#[sails_rs::event]
#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum AmmEvent {
    PoolCreated {
        pool_id: u64,
        token_a: ActorId,
        token_b: ActorId,
    },
    PoolActiveSet {
        pool_id: u64,
        active: bool,
    },
    LiquidityAdded {
        pool_id: u64,
        provider: ActorId,
        amount_a: u128,
        amount_b: u128,
        shares: u128,
    },
    LiquidityRemoved {
        pool_id: u64,
        provider: ActorId,
        amount_a: u128,
        amount_b: u128,
        shares: u128,
    },
    Swapped {
        pool_id: u64,
        trader: ActorId,
        token_in: ActorId,
        amount_in: u128,
        token_out: ActorId,
        amount_out: u128,
        fee: u128,
    },
}

#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct AmmPool {
    pub id: u64,
    pub token_a: ActorId,
    pub token_b: ActorId,
    /// Decimals of each token, verified against the VFT's own metadata at creation.
    pub dec_a: u8,
    pub dec_b: u8,
    /// Real tokens held by this program on behalf of the pool.
    pub reserve_a: u128,
    pub reserve_b: u128,
    /// Total LP shares issued, including the permanently locked minimum.
    pub total_shares: u128,
    /// Delisted pools reject deposits and swaps; removing liquidity stays open.
    pub active: bool,
}

/// Integer square root (Newton's method), for the initial share mint.
pub fn isqrt(n: u128) -> u128 {
    if n == 0 {
        return 0;
    }
    let mut x = n;
    let mut y = x.div_ceil(2);
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

/// Output of a constant-product swap, after the fee.
///
/// `amount_out = reserve_out * in_after_fee / (reserve_in + in_after_fee)`
///
/// Division floors, which leaves the remainder in the pool. Rounding therefore always
/// favours the LPs rather than the trader, which is the safe direction: it can never
/// make the pool pay out more than the invariant allows.
pub fn swap_output(
    amount_in: u128,
    reserve_in: u128,
    reserve_out: u128,
) -> Result<(u128, u128), AmmError> {
    if amount_in == 0 || reserve_in == 0 || reserve_out == 0 {
        return Err(AmmError::AmountTooSmall);
    }
    let fee = amount_in.checked_mul(FEE_BPS).ok_or(AmmError::Overflow)? / 10_000;
    let in_after_fee = amount_in - fee;
    let numerator = reserve_out
        .checked_mul(in_after_fee)
        .ok_or(AmmError::Overflow)?;
    let denominator = reserve_in
        .checked_add(in_after_fee)
        .ok_or(AmmError::Overflow)?;
    let out = numerator / denominator;
    // Never let a swap empty the pool: the invariant requires a non-zero reserve.
    if out == 0 || out >= reserve_out {
        return Err(AmmError::AmountTooSmall);
    }
    Ok((out, fee))
}

/// Shares minted for a deposit.
///
/// The first provider sets the price and receives `sqrt(a*b)`, less the permanently
/// locked minimum. Everyone after is minted the *smaller* of the two ratios, so
/// depositing out of proportion donates the excess to the pool rather than minting
/// shares for value that is not there.
pub fn shares_for_deposit(
    amount_a: u128,
    amount_b: u128,
    reserve_a: u128,
    reserve_b: u128,
    total_shares: u128,
) -> Result<u128, AmmError> {
    if total_shares == 0 {
        let product = amount_a.checked_mul(amount_b).ok_or(AmmError::Overflow)?;
        let initial = isqrt(product);
        if initial <= MINIMUM_LIQUIDITY {
            return Err(AmmError::AmountTooSmall);
        }
        return Ok(initial - MINIMUM_LIQUIDITY);
    }
    let by_a = amount_a
        .checked_mul(total_shares)
        .ok_or(AmmError::Overflow)?
        / reserve_a.max(1);
    let by_b = amount_b
        .checked_mul(total_shares)
        .ok_or(AmmError::Overflow)?
        / reserve_b.max(1);
    let shares = by_a.min(by_b);
    if shares == 0 {
        return Err(AmmError::AmountTooSmall);
    }
    Ok(shares)
}

pub struct AmmService<'a> {
    state: &'a RefCell<SpotState>,
}

impl<'a> AmmService<'a> {
    pub fn new(state: &'a RefCell<SpotState>) -> Self {
        Self { state }
    }
    fn require_admin(&self) -> Result<(), AmmError> {
        if msg::source() == self.state.borrow().admin {
            Ok(())
        } else {
            Err(AmmError::NotAdmin)
        }
    }
    fn require_running(&self) -> Result<(), AmmError> {
        if self.state.borrow().paused {
            Err(AmmError::Paused)
        } else {
            Ok(())
        }
    }
    fn pool(&self, id: u64) -> Result<AmmPool, AmmError> {
        self.state
            .borrow()
            .amm_pools
            .iter()
            .find(|p| p.id == id)
            .cloned()
            .ok_or(AmmError::NoPool)
    }
}

#[sails_rs::service(events = AmmEvent)]
impl<'a> AmmService<'a> {
    // ── Admin ──
    /// Create a pool for a token pair. Admin-only, like spot listing: a pool is a
    /// curated market, not something anyone can conjure.
    ///
    /// Decimals are verified against each token's own `VftMetadata` and rejected on
    /// mismatch, for the same reason listing does it (audit M-14).
    #[export]
    pub async fn create_pool(
        &mut self,
        token_a: ActorId,
        token_b: ActorId,
        dec_a: u8,
        dec_b: u8,
    ) -> Result<u64, AmmError> {
        self.require_admin()?;
        if token_a == ActorId::zero() || token_b == ActorId::zero() || token_a == token_b {
            return Err(AmmError::BadParams);
        }
        {
            let st = self.state.borrow();
            if st.amm_pools.len() >= MAX_POOLS {
                return Err(AmmError::TooManyPools);
            }
            if pair_exists(&st, token_a, token_b) {
                return Err(AmmError::PoolExists);
            }
        }
        match crate::spot::vft_decimals(token_a).await {
            Some(d) if d == dec_a => {}
            Some(_) => return Err(AmmError::DecimalsMismatch),
            None => return Err(AmmError::TransferFailed),
        }
        match crate::spot::vft_decimals(token_b).await {
            Some(d) if d == dec_b => {}
            Some(_) => return Err(AmmError::DecimalsMismatch),
            None => return Err(AmmError::TransferFailed),
        }
        let id = {
            let mut st = self.state.borrow_mut();
            // Re-check after the awaits; another creation could have landed.
            if pair_exists(&st, token_a, token_b) {
                return Err(AmmError::PoolExists);
            }
            let id = st.next_pool_id;
            st.next_pool_id += 1;
            st.amm_pools.push(AmmPool {
                id,
                token_a,
                token_b,
                dec_a,
                dec_b,
                reserve_a: 0,
                reserve_b: 0,
                total_shares: 0,
                active: true,
            });
            id
        };
        let _ = self.emit_event(AmmEvent::PoolCreated {
            pool_id: id,
            token_a,
            token_b,
        });
        Ok(id)
    }

    /// Stop or resume deposits and swaps on a pool. Removing liquidity is never
    /// blocked, so delisting cannot strand a provider's funds.
    #[export]
    pub fn set_pool_active(&mut self, pool_id: u64, active: bool) -> Result<(), AmmError> {
        self.require_admin()?;
        {
            let mut st = self.state.borrow_mut();
            let p = st
                .amm_pools
                .iter_mut()
                .find(|p| p.id == pool_id)
                .ok_or(AmmError::NoPool)?;
            p.active = active;
        }
        let _ = self.emit_event(AmmEvent::PoolActiveSet { pool_id, active });
        Ok(())
    }

    // ── Liquidity ──
    /// Deposit both tokens and receive LP shares.
    ///
    /// `min_shares` is the caller's bound: deposits are minted at the pool's ratio at
    /// execution time, which another trade can move between signing and landing.
    /// Requires a prior `approve` of each token.
    #[export]
    pub async fn add_liquidity(
        &mut self,
        pool_id: u64,
        amount_a: u128,
        amount_b: u128,
        min_shares: u128,
    ) -> Result<u128, AmmError> {
        self.require_running()?;
        if amount_a == 0 || amount_b == 0 {
            return Err(AmmError::BadParams);
        }
        let caller = msg::source();
        let pool = self.pool(pool_id)?;
        if !pool.active {
            return Err(AmmError::PoolInactive);
        }
        // Compute the mint before moving anything, so an unmeetable bound costs the
        // caller nothing but gas.
        let expected = shares_for_deposit(
            amount_a,
            amount_b,
            pool.reserve_a,
            pool.reserve_b,
            pool.total_shares,
        )?;
        if expected < min_shares {
            return Err(AmmError::SlippageExceeded);
        }

        // Two transfers. If the second fails after the first succeeded, the first is
        // credited back rather than kept (audit C-03).
        if !vft_transfer_from(pool.token_a, caller, amount_a).await {
            return Err(AmmError::TransferFailed);
        }
        if !vft_transfer_from(pool.token_b, caller, amount_b).await {
            let mut st = self.state.borrow_mut();
            st.credit(caller, pool.token_a, amount_a);
            return Err(AmmError::TransferFailed);
        }

        let minted = {
            let mut st = self.state.borrow_mut();
            let p = match st.amm_pools.iter_mut().find(|p| p.id == pool_id) {
                Some(p) => p,
                None => {
                    // Cannot happen in practice, but both deposits are already in.
                    st.credit(caller, pool.token_a, amount_a);
                    st.credit(caller, pool.token_b, amount_b);
                    return Err(AmmError::NoPool);
                }
            };
            // Recompute against reserves as they are now: the awaits above yield, so
            // another swap may have moved the ratio since the pre-check.
            let shares = match shares_for_deposit(
                amount_a,
                amount_b,
                p.reserve_a,
                p.reserve_b,
                p.total_shares,
            ) {
                Ok(v) if v >= min_shares => v,
                _ => {
                    let (ta, tb) = (p.token_a, p.token_b);
                    st.credit(caller, ta, amount_a);
                    st.credit(caller, tb, amount_b);
                    return Err(AmmError::SlippageExceeded);
                }
            };
            if p.total_shares == 0 {
                // Lock the minimum permanently by issuing it to nobody.
                p.total_shares = shares + MINIMUM_LIQUIDITY;
            } else {
                p.total_shares += shares;
            }
            p.reserve_a += amount_a;
            p.reserve_b += amount_b;
            *st.lp_shares.entry((caller, pool_id)).or_insert(0) += shares;
            shares
        };
        let _ = self.emit_event(AmmEvent::LiquidityAdded {
            pool_id,
            provider: caller,
            amount_a,
            amount_b,
            shares: minted,
        });
        Ok(minted)
    }

    /// Burn shares and take back the corresponding fraction of both reserves,
    /// including the fees accrued into them.
    ///
    /// Credited to claimable balances (withdraw with `Spot/Withdraw`), and never
    /// gated on the pause or on the pool being active: a provider must always be
    /// able to leave.
    #[export]
    pub fn remove_liquidity(
        &mut self,
        pool_id: u64,
        shares: u128,
        min_a: u128,
        min_b: u128,
    ) -> Result<(u128, u128), AmmError> {
        let caller = msg::source();
        if shares == 0 {
            return Err(AmmError::BadParams);
        }
        let (amount_a, amount_b) = {
            let mut st = self.state.borrow_mut();
            let held = *st.lp_shares.get(&(caller, pool_id)).unwrap_or(&0);
            if held < shares {
                return Err(AmmError::InsufficientShares);
            }
            let p = st
                .amm_pools
                .iter_mut()
                .find(|p| p.id == pool_id)
                .ok_or(AmmError::NoPool)?;
            if p.total_shares == 0 {
                return Err(AmmError::NoPool);
            }
            // Floor division leaves the remainder with the pool, so the last provider
            // out can never take more than their share.
            let amount_a = p.reserve_a.saturating_mul(shares) / p.total_shares;
            let amount_b = p.reserve_b.saturating_mul(shares) / p.total_shares;
            if amount_a < min_a || amount_b < min_b {
                return Err(AmmError::SlippageExceeded);
            }
            if amount_a == 0 && amount_b == 0 {
                return Err(AmmError::AmountTooSmall);
            }
            p.reserve_a -= amount_a;
            p.reserve_b -= amount_b;
            p.total_shares -= shares;
            let (ta, tb) = (p.token_a, p.token_b);
            if held == shares {
                st.lp_shares.remove(&(caller, pool_id));
            } else {
                st.lp_shares.insert((caller, pool_id), held - shares);
            }
            st.credit(caller, ta, amount_a);
            st.credit(caller, tb, amount_b);
            (amount_a, amount_b)
        };
        let _ = self.emit_event(AmmEvent::LiquidityRemoved {
            pool_id,
            provider: caller,
            amount_a,
            amount_b,
            shares,
        });
        Ok((amount_a, amount_b))
    }

    /// Swap `amount_in` of `token_in` for the other token, receiving at least
    /// `min_amount_out`. Requires a prior `approve` of `token_in`.
    ///
    /// The output is credited to the caller's claimable balance, on the same
    /// settlement path as spot, so no swap depends on a transfer succeeding mid-way.
    #[export]
    pub async fn swap(
        &mut self,
        pool_id: u64,
        token_in: ActorId,
        amount_in: u128,
        min_amount_out: u128,
    ) -> Result<u128, AmmError> {
        self.require_running()?;
        if amount_in == 0 {
            return Err(AmmError::BadParams);
        }
        let caller = msg::source();
        let pool = self.pool(pool_id)?;
        if !pool.active {
            return Err(AmmError::PoolInactive);
        }
        let a_to_b = if token_in == pool.token_a {
            true
        } else if token_in == pool.token_b {
            false
        } else {
            return Err(AmmError::BadParams);
        };
        let token_out = if a_to_b { pool.token_b } else { pool.token_a };

        // Quote before moving anything, so an unmeetable bound costs only gas.
        let (reserve_in, reserve_out) = if a_to_b {
            (pool.reserve_a, pool.reserve_b)
        } else {
            (pool.reserve_b, pool.reserve_a)
        };
        let (quoted, _) = swap_output(amount_in, reserve_in, reserve_out)?;
        if quoted < min_amount_out {
            return Err(AmmError::SlippageExceeded);
        }

        if !vft_transfer_from(token_in, caller, amount_in).await {
            return Err(AmmError::TransferFailed);
        }

        let (out, fee) = {
            let mut st = self.state.borrow_mut();
            let p = match st.amm_pools.iter_mut().find(|p| p.id == pool_id) {
                Some(p) => p,
                None => {
                    st.credit(caller, token_in, amount_in);
                    return Err(AmmError::NoPool);
                }
            };
            // Re-price against reserves as they are now; the await yielded.
            let (r_in, r_out) = if a_to_b {
                (p.reserve_a, p.reserve_b)
            } else {
                (p.reserve_b, p.reserve_a)
            };
            let (out, fee) = match swap_output(amount_in, r_in, r_out) {
                Ok(v) if v.0 >= min_amount_out => v,
                _ => {
                    st.credit(caller, token_in, amount_in);
                    return Err(AmmError::SlippageExceeded);
                }
            };
            // The whole input enters the pool, including the fee: that is what makes
            // k grow and what pays the liquidity providers.
            if a_to_b {
                p.reserve_a += amount_in;
                p.reserve_b -= out;
            } else {
                p.reserve_b += amount_in;
                p.reserve_a -= out;
            }
            st.credit(caller, token_out, out);
            (out, fee)
        };
        let _ = self.emit_event(AmmEvent::Swapped {
            pool_id,
            trader: caller,
            token_in,
            amount_in,
            token_out,
            amount_out: out,
            fee,
        });
        Ok(out)
    }

    // ── Reads ──
    #[export]
    pub fn get_pools(&self, offset: u32, limit: u32) -> Vec<AmmPool> {
        let take = limit.clamp(1, crate::spot::MAX_PAGE) as usize;
        self.state
            .borrow()
            .amm_pools
            .iter()
            .skip(offset as usize)
            .take(take)
            .cloned()
            .collect()
    }

    #[export]
    pub fn get_pool(&self, pool_id: u64) -> Option<AmmPool> {
        self.state
            .borrow()
            .amm_pools
            .iter()
            .find(|p| p.id == pool_id)
            .cloned()
    }

    /// The caller's LP shares in a pool, and what they are currently worth.
    #[export]
    pub fn get_position(&self, pool_id: u64) -> (u128, u128, u128) {
        let caller = msg::source();
        let st = self.state.borrow();
        let shares = *st.lp_shares.get(&(caller, pool_id)).unwrap_or(&0);
        let Some(p) = st.amm_pools.iter().find(|p| p.id == pool_id) else {
            return (0, 0, 0);
        };
        if p.total_shares == 0 || shares == 0 {
            return (shares, 0, 0);
        }
        (
            shares,
            p.reserve_a.saturating_mul(shares) / p.total_shares,
            p.reserve_b.saturating_mul(shares) / p.total_shares,
        )
    }

    /// Quote a swap without executing it: `(amount_out, fee)`.
    #[export]
    pub fn quote_swap(&self, pool_id: u64, token_in: ActorId, amount_in: u128) -> (u128, u128) {
        let st = self.state.borrow();
        let Some(p) = st.amm_pools.iter().find(|p| p.id == pool_id) else {
            return (0, 0);
        };
        let (r_in, r_out) = if token_in == p.token_a {
            (p.reserve_a, p.reserve_b)
        } else if token_in == p.token_b {
            (p.reserve_b, p.reserve_a)
        } else {
            return (0, 0);
        };
        swap_output(amount_in, r_in, r_out).unwrap_or((0, 0))
    }
}

/// Whether a pool for this pair already exists, in either orientation. Two pools for
/// the same pair would split liquidity across books that never see each other.
fn pair_exists(st: &SpotState, a: ActorId, b: ActorId) -> bool {
    st.amm_pools
        .iter()
        .any(|p| (p.token_a == a && p.token_b == b) || (p.token_a == b && p.token_b == a))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isqrt_is_the_floor_of_the_square_root() {
        assert_eq!(isqrt(0), 0);
        assert_eq!(isqrt(1), 1);
        assert_eq!(isqrt(24), 4);
        assert_eq!(isqrt(25), 5);
        assert_eq!(isqrt(1_000_000), 1_000);
        // Never overshoots, at any magnitude.
        for n in [2u128, 3, 99, 10_001, u128::from(u64::MAX)] {
            let r = isqrt(n);
            assert!(r * r <= n, "isqrt({n}) = {r} overshot");
            assert!((r + 1).checked_mul(r + 1).map(|v| v > n).unwrap_or(true));
        }
    }

    #[test]
    fn swap_takes_the_fee_and_grows_k() {
        let (ra, rb) = (1_000_000u128, 1_000_000u128);
        let k_before = ra * rb;
        let (out, fee) = swap_output(10_000, ra, rb).unwrap();
        assert_eq!(fee, 30, "0.3% of 10_000");
        // The whole input enters the pool; only `out` leaves.
        let k_after = (ra + 10_000) * (rb - out);
        assert!(
            k_after > k_before,
            "fees must grow k, which is how LPs earn"
        );
    }

    #[test]
    fn swap_output_falls_as_size_grows() {
        let (ra, rb) = (1_000_000u128, 1_000_000u128);
        let small = swap_output(1_000, ra, rb).unwrap().0;
        let large = swap_output(100_000, ra, rb).unwrap().0;
        // Price impact: ten times the input must return less than ten times the output.
        assert!(large < small * 100);
    }

    #[test]
    fn swap_can_never_drain_a_pool() {
        let (ra, rb) = (1_000u128, 1_000u128);
        // However large the input, the output stays strictly inside the reserve.
        for amount in [10_000u128, 1_000_000, u128::from(u64::MAX)] {
            match swap_output(amount, ra, rb) {
                Ok((out, _)) => assert!(out < rb, "swap drained the pool"),
                Err(_) => {}
            }
        }
    }

    #[test]
    fn first_deposit_locks_the_minimum() {
        let shares = shares_for_deposit(1_000_000, 1_000_000, 0, 0, 0).unwrap();
        assert_eq!(shares, 1_000_000 - MINIMUM_LIQUIDITY);
        // A first deposit too small to cover the lock is refused outright.
        assert_eq!(
            shares_for_deposit(10, 10, 0, 0, 0),
            Err(AmmError::AmountTooSmall),
        );
    }

    #[test]
    fn later_deposits_mint_on_the_smaller_ratio() {
        // Pool is 1000:1000 with 1000 shares. A balanced 10% deposit mints 10%.
        assert_eq!(
            shares_for_deposit(100, 100, 1_000, 1_000, 1_000).unwrap(),
            100
        );
        // Depositing double the B side mints on the A ratio; the excess is donated,
        // never minted for.
        assert_eq!(
            shares_for_deposit(100, 200, 1_000, 1_000, 1_000).unwrap(),
            100
        );
        assert_eq!(
            shares_for_deposit(200, 100, 1_000, 1_000, 1_000).unwrap(),
            100
        );
    }

    #[test]
    fn fees_accrue_to_share_value_not_to_a_separate_pot() {
        // One provider owns the whole pool (beyond the locked minimum).
        let (mut ra, mut rb) = (1_000_000u128, 1_000_000u128);
        let total = isqrt(ra * rb); // 1_000_000 shares, incl. the locked minimum
        let mine = total - MINIMUM_LIQUIDITY;
        let before = ra.saturating_mul(mine) / total;

        // Trade back and forth; each leg leaves its fee behind.
        for _ in 0..10 {
            let (out, _) = swap_output(10_000, ra, rb).unwrap();
            ra += 10_000;
            rb -= out;
            let (back, _) = swap_output(out, rb, ra).unwrap();
            rb += out;
            ra -= back;
        }
        let after = ra.saturating_mul(mine) / total;
        assert!(
            after > before,
            "the same shares must be worth more after fees ({before} -> {after})",
        );
    }
}
