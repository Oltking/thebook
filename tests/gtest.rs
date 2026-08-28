//! Integration tests for the v1 program (spot CLOB + cash-settled perps).
//!
//! Two rules the audit's M-15 finding exists to enforce, applied throughout:
//!
//! 1. **Every rejection path asserts balances, not just an error code.** The C-03
//!    margin-confiscation bug lived inside a test that checked only `res.is_err()`.
//!    An error return that silently keeps the user's money passes that assertion.
//! 2. **The solvency invariant is asserted after any test that moves value.**
//!    `assert_solvent` checks that the program's real token balance covers every
//!    claim, escrow, dust entry, and the reserve — the property that actually matters.
//!
//! The three reproduced exploits appear here as regression tests. Two of them
//! (C-01 `CallAgentService`, C-02 `Join`/`Withdraw` on virtual balances) can no
//! longer be *called*: the services carrying them were deleted, so the guarantee is
//! enforced by the compiler and by `legacy_attack_surface_is_gone`, which asserts
//! against the generated IDL. The third (C-03) is a live runtime test.

use sails_rs::client::*;
use sails_rs::gtest::*;
use sails_rs::ActorId;
use sails_rs::U256;

use thebook::WASM_BINARY;
use thebook_client::perps_v_1::io as perp1_io;
use thebook_client::spot::io as spot_io;
use thebook_client::*;
use thebook_token::WASM_BINARY as TOKEN_WASM;
use thebook_token_client::faucet::io as tok_faucet_io;
use thebook_token_client::vft::io as tok_vft_io;
use thebook_token_client::{
    ThebookTokenClient, ThebookTokenClientCtors, ThebookTokenClientProgram,
};

const ALICE: u64 = 1;
const BOB: u64 = 2;
const CAROL: u64 = 3;

/// Faucet mint per claim, per token.
const FAUCET_USD: u64 = 100_000;
const FAUCET_ETH: u64 = 1_000_000;

/// Handles for a deployed test environment.
struct Env {
    env: GtestEnv,
    program: Actor<ThebookClientProgram, GtestEnv>,
    usd: ActorId,
    eth: ActorId,
}

async fn deploy() -> Env {
    let system = System::new();
    for who in [ALICE, BOB, CAROL] {
        system.mint_to(who, 100_000_000_000_000_000);
    }
    let env = GtestEnv::new(system, ALICE.into());

    let code_id = env.system().submit_code(WASM_BINARY);
    let program = env
        .deploy::<ThebookClientProgram>(code_id, b"thebookdex".to_vec())
        .new()
        .await
        .unwrap();
    // The DEX sends VFT messages and must hold native balance to cover the
    // existential deposit reserved for each reply.
    env.system()
        .transfer(ALICE, program.id(), 10_000_000_000_000, false);

    let token_code = env.system().submit_code(TOKEN_WASM);
    let mut ids = alloc_ids();
    for (name, symbol, faucet, salt) in [
        ("wUSDT", "wUSDT", FAUCET_USD, b"usd".to_vec()),
        ("wETH", "wETH", FAUCET_ETH, b"eth".to_vec()),
    ] {
        let token = env
            .deploy::<ThebookTokenClientProgram>(token_code, salt)
            .new(name.to_string(), symbol.to_string(), 6, U256::from(faucet))
            .await
            .unwrap();
        ids.push(token.id());
    }
    Env { env, program, usd: ids[0], eth: ids[1] }
}

fn alloc_ids() -> Vec<ActorId> {
    Vec::new()
}

/// The DEX actor bound to a specific caller.
fn as_dex(env: &GtestEnv, dex: ActorId, who: u64) -> Actor<ThebookClientProgram, GtestEnv> {
    Actor::<ThebookClientProgram, GtestEnv>::new(env.clone().with_actor_id(who.into()), dex)
}

/// A token program actor bound to a specific caller.
fn as_tok(env: &GtestEnv, tid: ActorId, who: u64) -> Actor<ThebookTokenClientProgram, GtestEnv> {
    Actor::<ThebookTokenClientProgram, GtestEnv>::new(env.clone().with_actor_id(who.into()), tid)
}

async fn balance_of(env: &GtestEnv, token: ActorId, who: u64) -> u128 {
    let b: U256 = as_tok(env, token, who)
        .vft()
        .pending_call::<tok_vft_io::BalanceOf>((who.into(),))
        .await
        .unwrap();
    b.as_u128()
}

async fn program_balance(env: &GtestEnv, token: ActorId, dex: ActorId) -> u128 {
    let b: U256 = as_tok(env, token, ALICE)
        .vft()
        .pending_call::<tok_vft_io::BalanceOf>((dex,))
        .await
        .unwrap();
    b.as_u128()
}

async fn claim_of(env: &GtestEnv, dex: ActorId, who: u64, token: ActorId) -> u128 {
    as_dex(env, dex, who)
        .spot()
        .pending_call::<spot_io::GetClaim>((token,))
        .await
        .unwrap()
}

/// Claim `token`'s faucet as `who` and approve the DEX to pull `amount`.
async fn claim_and_approve(env: &GtestEnv, token: ActorId, dex: ActorId, who: u64, amount: u128) {
    let tok = as_tok(env, token, who);
    let _: U256 = tok
        .faucet()
        .pending_call::<tok_faucet_io::Claim>(())
        .await
        .unwrap()
        .unwrap();
    let _: bool = tok
        .vft()
        .pending_call::<tok_vft_io::Approve>((dex, U256::from(amount)))
        .await
        .unwrap();
}

/// Assert the solvency invariant for a token:
/// `balance_of(program) >= sum(claims) + escrow + dust + reserve`.
///
/// This is the property every other assertion is really about. It is checked with
/// the claims of every actor a test could have touched.
async fn assert_solvent(e: &Env, token: ActorId) {
    let dex = e.program.id();
    let (escrow, dust, reserve): (u128, u128, u128) = e
        .program
        .spot()
        .pending_call::<spot_io::GetSolvency>((token,))
        .await
        .unwrap();
    let mut claims = 0u128;
    for who in [ALICE, BOB, CAROL] {
        claims += claim_of(&e.env, dex, who, token).await;
    }
    let held = program_balance(&e.env, token, dex).await;
    assert!(
        held >= claims + escrow + dust + reserve,
        "insolvent: held {held} < claims {claims} + escrow {escrow} + dust {dust} + reserve {reserve}",
    );
}

/// List an ETH/USDT spot pair (both 6-decimal test tokens) as the admin.
async fn list_eth_usd(e: &Env) -> u64 {
    e.program
        .spot()
        .pending_call::<spot_io::ListPair>((e.eth, e.usd, 6u8, 6u8))
        .await
        .unwrap()
        .unwrap()
}

// ── Listing and admin ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn spot_only_admin_can_list() {
    let e = deploy().await;
    let denied: Result<u64, _> = as_dex(&e.env, e.program.id(), BOB)
        .spot()
        .pending_call::<spot_io::ListPair>((e.eth, e.usd, 6u8, 6u8))
        .await
        .unwrap();
    assert!(denied.is_err(), "non-admin must not list a pair");
}

/// Audit M-14: decimals are read from the token, not taken on the admin's word.
#[tokio::test]
async fn spot_listing_rejects_wrong_decimals() {
    let e = deploy().await;
    let wrong: Result<u64, _> = e
        .program
        .spot()
        .pending_call::<spot_io::ListPair>((e.eth, e.usd, 18u8, 6u8))
        .await
        .unwrap();
    assert!(wrong.is_err(), "a decimals value the token disagrees with must be rejected");
    // The correct value still lists.
    assert_eq!(list_eth_usd(&e).await, 0);
}

/// Audit M-14: the same asset pair must not be listable in both orientations.
#[tokio::test]
async fn spot_listing_rejects_reverse_orientation() {
    let e = deploy().await;
    list_eth_usd(&e).await;
    let reversed: Result<u64, _> = e
        .program
        .spot()
        .pending_call::<spot_io::ListPair>((e.usd, e.eth, 6u8, 6u8))
        .await
        .unwrap();
    assert!(reversed.is_err(), "reverse orientation splits liquidity and must be rejected");
}

/// Audit M-14: delisting is reversible.
#[tokio::test]
async fn spot_delist_is_reversible() {
    let e = deploy().await;
    let dex = e.program.id();
    let pair = list_eth_usd(&e).await;
    let _: () = e.program.spot().pending_call::<spot_io::DelistPair>((pair,)).await.unwrap().unwrap();

    claim_and_approve(&e.env, e.eth, dex, BOB, 300_000).await;
    let blocked: Result<u64, _> = as_dex(&e.env, dex, BOB)
        .spot()
        .pending_call::<spot_io::PlaceLimit>((pair, Side::Sell, 200u128, 300_000u128))
        .await
        .unwrap();
    assert!(blocked.is_err(), "a delisted pair takes no new orders");

    let _: () = e.program.spot().pending_call::<spot_io::RelistPair>((pair,)).await.unwrap().unwrap();
    let ok: Result<u64, _> = as_dex(&e.env, dex, BOB)
        .spot()
        .pending_call::<spot_io::PlaceLimit>((pair, Side::Sell, 200u128, 300_000u128))
        .await
        .unwrap();
    assert!(ok.is_ok(), "relisting must restore trading");
}

/// Audit H-05: admin handover is two-step, so a typo is recoverable.
#[tokio::test]
async fn admin_handover_requires_acceptance() {
    let e = deploy().await;
    let dex = e.program.id();
    let _: () = e
        .program
        .spot()
        .pending_call::<spot_io::ProposeAdmin>((ActorId::from(BOB),))
        .await
        .unwrap()
        .unwrap();
    // Not admin yet: BOB still cannot list.
    let too_early: Result<u64, _> = as_dex(&e.env, dex, BOB)
        .spot()
        .pending_call::<spot_io::ListPair>((e.eth, e.usd, 6u8, 6u8))
        .await
        .unwrap();
    assert!(too_early.is_err(), "a proposal alone must not grant authority");
    // A third party cannot accept on BOB's behalf.
    let stolen: Result<(), _> = as_dex(&e.env, dex, CAROL)
        .spot()
        .pending_call::<spot_io::AcceptAdmin>(())
        .await
        .unwrap();
    assert!(stolen.is_err(), "only the proposed account may accept");

    let _: () = as_dex(&e.env, dex, BOB)
        .spot()
        .pending_call::<spot_io::AcceptAdmin>(())
        .await
        .unwrap()
        .unwrap();
    let now: Result<u64, _> = as_dex(&e.env, dex, BOB)
        .spot()
        .pending_call::<spot_io::ListPair>((e.eth, e.usd, 6u8, 6u8))
        .await
        .unwrap();
    assert!(now.is_ok(), "the accepted admin has authority");
}

/// Audit H-08: a pause blocks new orders but never traps funds.
#[tokio::test]
async fn pause_blocks_orders_but_never_cancel_or_withdraw() {
    let e = deploy().await;
    let dex = e.program.id();
    let pair = list_eth_usd(&e).await;

    claim_and_approve(&e.env, e.eth, dex, BOB, 300_000).await;
    let oid: u64 = as_dex(&e.env, dex, BOB)
        .spot()
        .pending_call::<spot_io::PlaceLimit>((pair, Side::Sell, 200u128, 300_000u128))
        .await
        .unwrap()
        .unwrap();

    let _: () = e.program.spot().pending_call::<spot_io::SetPaused>((true,)).await.unwrap().unwrap();

    let blocked: Result<u64, _> = as_dex(&e.env, dex, BOB)
        .spot()
        .pending_call::<spot_io::PlaceLimit>((pair, Side::Sell, 200u128, 100_000u128))
        .await
        .unwrap();
    assert!(blocked.is_err(), "paused venue takes no new orders");

    // Cancel and withdraw must both still work while paused — this is the whole
    // point of the design: a pause must never trap user funds.
    let _: () = as_dex(&e.env, dex, BOB)
        .spot()
        .pending_call::<spot_io::CancelOrder>((oid,))
        .await
        .unwrap()
        .unwrap();
    let w: u128 = as_dex(&e.env, dex, BOB)
        .spot()
        .pending_call::<spot_io::Withdraw>((e.eth, None::<u128>))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(w, 300_000, "escrow is fully recoverable while paused");
    assert_eq!(balance_of(&e.env, e.eth, BOB).await, FAUCET_ETH as u128);
    assert_solvent(&e, e.eth).await;
}

// ── Matching ────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn spot_limit_cross_and_withdraw() {
    let e = deploy().await;
    let dex = e.program.id();
    let pair = list_eth_usd(&e).await;

    claim_and_approve(&e.env, e.eth, dex, BOB, 500_000).await;
    let sell_oid: u64 = as_dex(&e.env, dex, BOB)
        .spot()
        .pending_call::<spot_io::PlaceLimit>((pair, Side::Sell, 100u128, 500_000u128))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(sell_oid, 0);
    assert_eq!(balance_of(&e.env, e.eth, BOB).await, 500_000);

    // Buyer ALICE: escrow = notional(100, 500_000, 6) = 50 quote.
    claim_and_approve(&e.env, e.usd, dex, ALICE, 50).await;
    let _: u64 = e
        .program
        .spot()
        .pending_call::<spot_io::PlaceLimit>((pair, Side::Buy, 100u128, 500_000u128))
        .await
        .unwrap()
        .unwrap();

    assert_eq!(claim_of(&e.env, dex, ALICE, e.eth).await, 500_000, "buyer receives the base");
    assert_eq!(claim_of(&e.env, dex, BOB, e.usd).await, 50, "seller receives the quote");

    // Both orders fully filled, so neither rests: the book is empty again (H-02).
    let resting: u64 = e.program.spot().pending_call::<spot_io::RestingOrderCount>(()).await.unwrap();
    assert_eq!(resting, 0, "filled orders must not linger in state");

    let w1: u128 = e
        .program
        .spot()
        .pending_call::<spot_io::Withdraw>((e.eth, None::<u128>))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(w1, 500_000);
    // ALICE only ever claimed the quote faucet, so her base balance is exactly what
    // she just bought.
    assert_eq!(balance_of(&e.env, e.eth, ALICE).await, 500_000);
    assert_solvent(&e, e.eth).await;
    assert_solvent(&e, e.usd).await;
}

/// Audit L-01: a partial withdraw leaves the rest claimable.
#[tokio::test]
async fn spot_partial_withdraw_leaves_the_remainder() {
    let e = deploy().await;
    let dex = e.program.id();
    let pair = list_eth_usd(&e).await;

    claim_and_approve(&e.env, e.eth, dex, BOB, 300_000).await;
    let oid: u64 = as_dex(&e.env, dex, BOB)
        .spot()
        .pending_call::<spot_io::PlaceLimit>((pair, Side::Sell, 200u128, 300_000u128))
        .await
        .unwrap()
        .unwrap();
    let _: () = as_dex(&e.env, dex, BOB)
        .spot()
        .pending_call::<spot_io::CancelOrder>((oid,))
        .await
        .unwrap()
        .unwrap();

    let part: u128 = as_dex(&e.env, dex, BOB)
        .spot()
        .pending_call::<spot_io::Withdraw>((e.eth, Some(100_000u128)))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(part, 100_000);
    assert_eq!(claim_of(&e.env, dex, BOB, e.eth).await, 200_000, "the rest stays claimable");

    // Over-withdrawing the remainder is rejected without moving anything.
    let too_much: Result<u128, _> = as_dex(&e.env, dex, BOB)
        .spot()
        .pending_call::<spot_io::Withdraw>((e.eth, Some(999_999u128)))
        .await
        .unwrap();
    assert!(too_much.is_err());
    assert_eq!(claim_of(&e.env, dex, BOB, e.eth).await, 200_000);
    assert_solvent(&e, e.eth).await;
}

#[tokio::test]
async fn spot_cancel_refunds_escrow_exactly() {
    let e = deploy().await;
    let dex = e.program.id();
    let pair = list_eth_usd(&e).await;

    claim_and_approve(&e.env, e.eth, dex, BOB, 300_000).await;
    let oid: u64 = as_dex(&e.env, dex, BOB)
        .spot()
        .pending_call::<spot_io::PlaceLimit>((pair, Side::Sell, 200u128, 300_000u128))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claim_of(&e.env, dex, BOB, e.eth).await, 0, "escrow is not claimable while resting");

    let _: () = as_dex(&e.env, dex, BOB)
        .spot()
        .pending_call::<spot_io::CancelOrder>((oid,))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claim_of(&e.env, dex, BOB, e.eth).await, 300_000, "cancel refunds the full escrow");

    let resting: u64 = e.program.spot().pending_call::<spot_io::RestingOrderCount>(()).await.unwrap();
    assert_eq!(resting, 0, "a cancelled order must be removed, not marked");
    assert_solvent(&e, e.eth).await;
}

/// Audit H-02: the order vector used to grow forever, so the venue had a lifetime
/// budget of 10_000 orders. Placing and clearing many orders must leave state flat.
#[tokio::test]
async fn spot_state_does_not_grow_with_completed_orders() {
    let e = deploy().await;
    let dex = e.program.id();
    let pair = list_eth_usd(&e).await;

    claim_and_approve(&e.env, e.eth, dex, BOB, 500_000).await;
    for round in 0..25u128 {
        let oid: u64 = as_dex(&e.env, dex, BOB)
            .spot()
            .pending_call::<spot_io::PlaceLimit>((pair, Side::Sell, 100 + round, 10_000u128))
            .await
            .unwrap()
            .unwrap();
        let _: () = as_dex(&e.env, dex, BOB)
            .spot()
            .pending_call::<spot_io::CancelOrder>((oid,))
            .await
            .unwrap()
            .unwrap();
    }
    let resting: u64 = e.program.spot().pending_call::<spot_io::RestingOrderCount>(()).await.unwrap();
    assert_eq!(resting, 0, "25 placed-and-cancelled orders must leave no residue");

    // The book read is also clean — no zero-quantity ghost levels.
    let (bids, asks): (Vec<(u128, u128)>, Vec<(u128, u128)>) = e
        .program
        .spot()
        .pending_call::<spot_io::GetOrderbook>((pair, 50u32))
        .await
        .unwrap();
    assert!(bids.is_empty() && asks.is_empty(), "cleared book must read empty");
    assert_solvent(&e, e.eth).await;
}

/// Audit L-02: a trader must not fill their own resting order.
#[tokio::test]
async fn spot_self_trading_is_rejected() {
    let e = deploy().await;
    let dex = e.program.id();
    let pair = list_eth_usd(&e).await;

    claim_and_approve(&e.env, e.eth, dex, BOB, 500_000).await;
    let _: u64 = as_dex(&e.env, dex, BOB)
        .spot()
        .pending_call::<spot_io::PlaceLimit>((pair, Side::Sell, 100u128, 500_000u128))
        .await
        .unwrap()
        .unwrap();
    // BOB now tries to buy his own ask.
    claim_and_approve(&e.env, e.usd, dex, BOB, 50).await;
    let _: u64 = as_dex(&e.env, dex, BOB)
        .spot()
        .pending_call::<spot_io::PlaceLimit>((pair, Side::Buy, 100u128, 500_000u128))
        .await
        .unwrap()
        .unwrap();
    // Nothing crossed: both orders rest, no wash volume was printed.
    let resting: u64 = e.program.spot().pending_call::<spot_io::RestingOrderCount>(()).await.unwrap();
    assert_eq!(resting, 2, "a self-cross must leave both orders resting");
    assert_eq!(claim_of(&e.env, dex, BOB, e.eth).await, 0);
    assert_solvent(&e, e.eth).await;
    assert_solvent(&e, e.usd).await;
}

/// Audit H-03: a market sell with no slippage bound sweeps whatever exists. With a
/// bound, an unacceptable sweep reverts and returns everything.
#[tokio::test]
async fn spot_market_sell_honours_its_slippage_bound() {
    let e = deploy().await;
    let dex = e.program.id();
    let pair = list_eth_usd(&e).await;

    // A lone lowball bid: 100_000 base at price 10 → 1 quote of proceeds.
    claim_and_approve(&e.env, e.usd, dex, ALICE, 1).await;
    let _: u64 = e
        .program
        .spot()
        .pending_call::<spot_io::PlaceLimit>((pair, Side::Buy, 10u128, 100_000u128))
        .await
        .unwrap()
        .unwrap();

    claim_and_approve(&e.env, e.eth, dex, BOB, 100_000).await;
    let before = balance_of(&e.env, e.eth, BOB).await;
    // BOB demands at least 50 quote. The book can only pay 1, so this must revert.
    let rejected: Result<u64, _> = as_dex(&e.env, dex, BOB)
        .spot()
        .pending_call::<spot_io::MarketSell>((pair, 100_000u128, 50u128))
        .await
        .unwrap();
    assert!(rejected.is_err(), "a fill below the bound must be rejected");

    // The critical assertion: the rejection returned the base. An error code alone
    // would not have caught the escrow being kept.
    assert_eq!(
        claim_of(&e.env, dex, BOB, e.eth).await,
        100_000,
        "a rejected market sell must return the full escrow",
    );
    assert_eq!(claim_of(&e.env, dex, BOB, e.usd).await, 0, "and must not have sold anything");
    let _: u128 = as_dex(&e.env, dex, BOB)
        .spot()
        .pending_call::<spot_io::Withdraw>((e.eth, None::<u128>))
        .await
        .unwrap()
        .unwrap();
    // Back to exactly where he started: the escrow round-tripped, nothing was lost.
    assert_eq!(balance_of(&e.env, e.eth, BOB).await, before);
    assert_solvent(&e, e.eth).await;
    assert_solvent(&e, e.usd).await;
}

/// Audit H-03, buy side: `min_base_out` bounds the price, which `max_quote` alone
/// never did.
#[tokio::test]
async fn spot_market_buy_honours_its_slippage_bound() {
    let e = deploy().await;
    let dex = e.program.id();
    let pair = list_eth_usd(&e).await;

    // A single expensive ask: only 10_000 base available at price 500.
    claim_and_approve(&e.env, e.eth, dex, ALICE, 10_000).await;
    let _: u64 = e
        .program
        .spot()
        .pending_call::<spot_io::PlaceLimit>((pair, Side::Sell, 500u128, 10_000u128))
        .await
        .unwrap()
        .unwrap();

    claim_and_approve(&e.env, e.usd, dex, BOB, 100).await;
    // BOB budgets 100 quote and insists on at least 50_000 base. Only 10_000 is on
    // offer, so the order must revert with the budget returned.
    let rejected: Result<u64, _> = as_dex(&e.env, dex, BOB)
        .spot()
        .pending_call::<spot_io::MarketBuy>((pair, 50_000u128, 100u128, 50_000u128))
        .await
        .unwrap();
    assert!(rejected.is_err());
    assert_eq!(
        claim_of(&e.env, dex, BOB, e.usd).await,
        100,
        "a rejected market buy must return the full budget",
    );
    assert_eq!(claim_of(&e.env, dex, BOB, e.eth).await, 0);
    assert_solvent(&e, e.usd).await;
}

#[tokio::test]
async fn spot_market_buy_refunds_unspent_budget() {
    let e = deploy().await;
    let dex = e.program.id();
    let pair = list_eth_usd(&e).await;

    claim_and_approve(&e.env, e.eth, dex, ALICE, 10_000).await;
    let _: u64 = e
        .program
        .spot()
        .pending_call::<spot_io::PlaceLimit>((pair, Side::Sell, 100u128, 10_000u128))
        .await
        .unwrap()
        .unwrap();

    claim_and_approve(&e.env, e.usd, dex, BOB, 100).await;
    // Cost of the whole ask is notional(100, 10_000, 6) = 1. Budget 100, no minimum.
    let _: u64 = as_dex(&e.env, dex, BOB)
        .spot()
        .pending_call::<spot_io::MarketBuy>((pair, 10_000u128, 100u128, 0u128))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claim_of(&e.env, dex, BOB, e.eth).await, 10_000);
    assert_eq!(claim_of(&e.env, dex, BOB, e.usd).await, 99, "unspent budget refunded");
    assert_solvent(&e, e.usd).await;
    assert_solvent(&e, e.eth).await;
}

#[tokio::test]
async fn spot_market_buy_empty_book_refunds_all() {
    let e = deploy().await;
    let dex = e.program.id();
    let pair = list_eth_usd(&e).await;

    claim_and_approve(&e.env, e.usd, dex, BOB, 100).await;
    let _: u64 = as_dex(&e.env, dex, BOB)
        .spot()
        .pending_call::<spot_io::MarketBuy>((pair, 10_000u128, 100u128, 0u128))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claim_of(&e.env, dex, BOB, e.usd).await, 100, "empty book returns the whole budget");
    assert_solvent(&e, e.usd).await;
}

#[tokio::test]
async fn spot_place_without_approval_reverts_cleanly() {
    let e = deploy().await;
    let dex = e.program.id();
    let pair = list_eth_usd(&e).await;

    // Faucet claimed, but no approval granted.
    let _: U256 = as_tok(&e.env, e.eth, BOB)
        .faucet()
        .pending_call::<tok_faucet_io::Claim>(())
        .await
        .unwrap()
        .unwrap();
    let res: Result<u64, _> = as_dex(&e.env, dex, BOB)
        .spot()
        .pending_call::<spot_io::PlaceLimit>((pair, Side::Sell, 100u128, 100_000u128))
        .await
        .unwrap();
    assert!(res.is_err(), "no allowance means no order");
    assert_eq!(balance_of(&e.env, e.eth, BOB).await, FAUCET_ETH as u128, "nothing left the wallet");
    assert_eq!(claim_of(&e.env, dex, BOB, e.eth).await, 0);
}

#[tokio::test]
async fn spot_unknown_pair_rejects() {
    let e = deploy().await;
    let res: Result<u64, _> = e
        .program
        .spot()
        .pending_call::<spot_io::PlaceLimit>((99u64, Side::Buy, 1u128, 1u128))
        .await
        .unwrap();
    assert!(res.is_err(), "unknown pair id must be rejected");
}

// ── Perps ───────────────────────────────────────────────────────────────────────────

/// Set up perps: USDT collateral, a keeper, one capped market, a funded reserve.
async fn setup_perps(e: &Env, max_oi: u128) -> u64 {
    let dex = e.program.id();
    let _: () = e
        .program
        .perps_v_1()
        .pending_call::<perp1_io::SetCollateral>((e.usd,))
        .await
        .unwrap()
        .unwrap();
    // The keeper is CAROL — a separate key from admin (audit H-04/H-09).
    let _: () = e
        .program
        .perps_v_1()
        .pending_call::<perp1_io::SetKeeper>((ActorId::from(CAROL),))
        .await
        .unwrap()
        .unwrap();
    let market: u64 = e
        .program
        .perps_v_1()
        .pending_call::<perp1_io::AddMarket>(("ETH".to_string(), max_oi))
        .await
        .unwrap()
        .unwrap();
    set_mark(e, market, 2000).await;
    claim_and_approve(&e.env, e.usd, dex, ALICE, 50_000).await;
    let _: u128 = e
        .program
        .perps_v_1()
        .pending_call::<perp1_io::FundReserve>((50_000u128,))
        .await
        .unwrap()
        .unwrap();
    market
}

async fn set_mark(e: &Env, market: u64, price: u128) {
    let _: () = as_dex(&e.env, e.program.id(), CAROL)
        .perps_v_1()
        .pending_call::<perp1_io::SetMark>((market, price))
        .await
        .unwrap()
        .unwrap();
}

/// Audit M-03: a market cannot be created without an explicit open-interest cap.
#[tokio::test]
async fn perps_market_requires_an_oi_cap() {
    let e = deploy().await;
    let unbounded: Result<u64, _> = e
        .program
        .perps_v_1()
        .pending_call::<perp1_io::AddMarket>(("ETH".to_string(), 0u128))
        .await
        .unwrap();
    assert!(unbounded.is_err(), "an uncapped market must not be creatable");
}

/// Audit L-04: the zero address is not a keeper.
#[tokio::test]
async fn perps_keeper_cannot_be_the_zero_address() {
    let e = deploy().await;
    let res: Result<(), _> = e
        .program
        .perps_v_1()
        .pending_call::<perp1_io::SetKeeper>((ActorId::zero(),))
        .await
        .unwrap();
    assert!(res.is_err(), "zero keeper silently leaves admin as the mark authority");
}

/// Audit H-04: one key cannot reprice the book in a single step, and admin is not
/// implicitly a keeper.
#[tokio::test]
async fn perps_mark_updates_are_bounded_and_keeper_only() {
    let e = deploy().await;
    let market = setup_perps(&e, u128::MAX / 2).await;

    // Admin is not the keeper any more.
    let as_admin: Result<(), _> = e
        .program
        .perps_v_1()
        .pending_call::<perp1_io::SetMark>((market, 2010u128))
        .await
        .unwrap();
    assert!(as_admin.is_err(), "admin must not double as the keeper");

    // A 50% jump from 2000 is far outside the 10% bound.
    let wild: Result<(), _> = as_dex(&e.env, e.program.id(), CAROL)
        .perps_v_1()
        .pending_call::<perp1_io::SetMark>((market, 3000u128))
        .await
        .unwrap();
    assert!(wild.is_err(), "a mark deviation beyond the bound must be rejected");

    // A move within the bound is accepted.
    set_mark(&e, market, 2100).await;
}

#[tokio::test]
async fn perps_open_close_profit_settles_to_claim() {
    let e = deploy().await;
    let dex = e.program.id();
    let market = setup_perps(&e, u128::MAX / 2).await;

    claim_and_approve(&e.env, e.usd, dex, BOB, 10_000).await;
    let pos: u64 = as_dex(&e.env, dex, BOB)
        .perps_v_1()
        .pending_call::<perp1_io::OpenPosition>((market, true, 10_000u128, 2u32))
        .await
        .unwrap()
        .unwrap();
    // Mark rises 5% (within the deviation bound): pnl = 20_000 * 100 / 2000 = 1_000.
    set_mark(&e, market, 2100).await;
    let (payout, pnl): (u128, i128) = as_dex(&e.env, dex, BOB)
        .perps_v_1()
        .pending_call::<perp1_io::ClosePosition>((pos,))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(pnl, 1_000);
    // notional 20_000 → open fee 20 (margin 9_980); payout 10_980 − close fee 20.
    assert_eq!(payout, 10_960, "margin + profit − 0.1%/side fees");
    assert_eq!(claim_of(&e.env, dex, BOB, e.usd).await, 10_960);
    assert_solvent(&e, e.usd).await;
}

/// Audit C-03 — the reproduced exploit, inverted into a regression test.
///
/// The original `perps_oi_cap_and_fee_revenue` asserted only `res.is_err()`, which
/// is exactly why the bug shipped: the rejection *did* return an error, and also
/// kept 10_000 of the trader's margin. These balance assertions are the test.
#[tokio::test]
async fn perps_rejected_open_returns_the_margin() {
    let e = deploy().await;
    let dex = e.program.id();
    let market = setup_perps(&e, 25_000).await;

    claim_and_approve(&e.env, e.usd, dex, BOB, 20_000).await;
    let wallet_before = balance_of(&e.env, e.usd, BOB).await;

    // First open: notional 20_000, within the 25_000 cap.
    let _: u64 = as_dex(&e.env, dex, BOB)
        .perps_v_1()
        .pending_call::<perp1_io::OpenPosition>((market, true, 10_000u128, 2u32))
        .await
        .unwrap()
        .unwrap();
    let reserve: u128 = e.program.perps_v_1().pending_call::<perp1_io::GetReserve>(()).await.unwrap();
    assert_eq!(reserve, 50_020, "reserve grew by the open fee");
    assert_eq!(balance_of(&e.env, e.usd, BOB).await, wallet_before - 10_000);

    // Second open would push long OI to 40_000, past the cap. It must be rejected —
    // and it must not take the margin.
    let res: Result<u64, _> = as_dex(&e.env, dex, BOB)
        .perps_v_1()
        .pending_call::<perp1_io::OpenPosition>((market, true, 10_000u128, 2u32))
        .await
        .unwrap();
    assert!(res.is_err(), "the open-interest cap must reject the second position");

    // These two assertions are the regression test. Before the fix the rejection
    // returned `Err(OiCapExceeded)` *and* kept 10_000 — the wallet was down 20_000
    // with only one position to show for it. The cap is now checked before the
    // escrow, so the second 10_000 never leaves the wallet at all.
    assert_eq!(
        balance_of(&e.env, e.usd, BOB).await,
        wallet_before - 10_000,
        "C-03: a rejected open must not take a second margin from the wallet",
    );
    assert_eq!(
        claim_of(&e.env, dex, BOB, e.usd).await,
        0,
        "nothing was escrowed, so there is nothing to credit back",
    );
    assert_solvent(&e, e.usd).await;
}

/// Audit C-03, other rejection paths: each is caught before the escrow, so nothing
/// leaves the wallet at all.
#[tokio::test]
async fn perps_invalid_open_rejects_before_escrow() {
    let e = deploy().await;
    let dex = e.program.id();
    let market = setup_perps(&e, u128::MAX / 2).await;

    claim_and_approve(&e.env, e.usd, dex, BOB, 10_000).await;
    let before = balance_of(&e.env, e.usd, BOB).await;

    for (margin, leverage, why) in [
        (10_000u128, 21u32, "leverage above the maximum"),
        (10_000, 0, "zero leverage"),
        (0, 5, "zero margin"),
    ] {
        let res: Result<u64, _> = as_dex(&e.env, dex, BOB)
            .perps_v_1()
            .pending_call::<perp1_io::OpenPosition>((market, true, margin, leverage))
            .await
            .unwrap();
        assert!(res.is_err(), "{why} must be rejected");
        assert_eq!(balance_of(&e.env, e.usd, BOB).await, before, "{why}: escrow never happened");
        assert_eq!(claim_of(&e.env, dex, BOB, e.usd).await, 0, "{why}: nothing credited");
    }

    // An unknown market is also refused before any transfer.
    let res: Result<u64, _> = as_dex(&e.env, dex, BOB)
        .perps_v_1()
        .pending_call::<perp1_io::OpenPosition>((99u64, true, 10_000u128, 2u32))
        .await
        .unwrap();
    assert!(res.is_err());
    assert_eq!(balance_of(&e.env, e.usd, BOB).await, before);
}

/// Audit H-05: the reserve backing open positions cannot be withdrawn.
#[tokio::test]
async fn perps_reserve_withdrawal_is_capped_by_open_liability() {
    let e = deploy().await;
    let dex = e.program.id();
    let market = setup_perps(&e, u128::MAX / 2).await;

    claim_and_approve(&e.env, e.usd, dex, BOB, 10_000).await;
    let _: u64 = as_dex(&e.env, dex, BOB)
        .perps_v_1()
        .pending_call::<perp1_io::OpenPosition>((market, true, 10_000u128, 2u32))
        .await
        .unwrap()
        .unwrap();
    set_mark(&e, market, 2100).await; // BOB is up 1_000

    let (reserve, liability, coverage): (u128, u128, u128) = e
        .program
        .perps_v_1()
        .pending_call::<perp1_io::GetReserveHealth>(())
        .await
        .unwrap();
    assert!(liability > 0, "an in-profit position is a liability");
    assert!(coverage > 10_000, "reserve should be over-covered here");

    // Draining everything must fail rather than silently truncate BOB's payout.
    let drain: Result<u128, _> = e
        .program
        .perps_v_1()
        .pending_call::<perp1_io::WithdrawReserve>((reserve,))
        .await
        .unwrap();
    assert!(drain.is_err(), "H-05: the reserve owed to traders is not the operator's to take");

    // Withdrawing genuine surplus still works.
    let surplus = reserve - liability;
    let ok: u128 = e
        .program
        .perps_v_1()
        .pending_call::<perp1_io::WithdrawReserve>((surplus,))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(ok, liability);
    assert_solvent(&e, e.usd).await;
}

#[tokio::test]
async fn perps_liquidation_pays_the_liquidator() {
    let e = deploy().await;
    let dex = e.program.id();
    let market = setup_perps(&e, u128::MAX / 2).await;

    claim_and_approve(&e.env, e.usd, dex, BOB, 10_000).await;
    let pos: u64 = as_dex(&e.env, dex, BOB)
        .perps_v_1()
        .pending_call::<perp1_io::OpenPosition>((market, true, 10_000u128, 10u32))
        .await
        .unwrap()
        .unwrap();

    // Walk the mark down inside the deviation bound until the position is under water.
    for price in [1900u128, 1810] {
        set_mark(&e, market, price).await;
    }
    // ALICE liquidates and must be paid for it (audit L-07).
    let _: () = e
        .program
        .perps_v_1()
        .pending_call::<perp1_io::Liquidate>((pos,))
        .await
        .unwrap()
        .unwrap();
    let fee = claim_of(&e.env, dex, ALICE, e.usd).await;
    assert!(fee > 0, "L-07: a liquidator must be paid even when equity has gapped away");

    let again: Result<(), _> = e
        .program
        .perps_v_1()
        .pending_call::<perp1_io::Liquidate>((pos,))
        .await
        .unwrap();
    assert!(again.is_err(), "the position is gone");
    assert_solvent(&e, e.usd).await;
}

// ── The deleted attack surface ──────────────────────────────────────────────────────

/// Audit C-01 and C-02, as a structural regression test.
///
/// `Orderbook/CallAgentService` let any caller send an arbitrary payload to an
/// arbitrary program *as the DEX*, which is the contract's signing authority handed
/// out. `Orderbook/Join` minted a virtual balance that `Orderbook/Withdraw` paid out
/// in real tokens. Both lived in services that shared this program's account.
///
/// Neither can be called any more because neither service exists. This asserts that
/// against the generated IDL, so re-adding one fails here rather than on mainnet.
#[test]
fn legacy_attack_surface_is_gone() {
    let idl = include_str!("../client/thebook_client.idl");
    for banned in [
        "CallAgentService", // C-01: arbitrary cross-program call
        "SeedHouse",        // C-02: virtual house stockpile
        "service Orderbook",
        "service Amm",
        "service Perps ",
    ] {
        assert!(
            !idl.contains(banned),
            "`{banned}` is back in the deployed interface — see audit C-01/C-02",
        );
    }
    // The services that should be there, are.
    assert!(idl.contains("service Spot"));
    assert!(idl.contains("service PerpsV1"));
}
