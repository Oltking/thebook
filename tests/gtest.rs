use sails_rs::ActorId;
use sails_rs::U256;
use sails_rs::client::*;
use sails_rs::gtest::*;

use thebook::WASM_BINARY;
use thebook_client::amm::io as amm_io;
use thebook_client::orderbook::io as ob_io;
use thebook_client::perps::io as perp_io;
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

// Starting balances every test agent is funded to — via the real faucet→deposit
// flow, not free money on join. Each backing token's faucet mints exactly this.
const INITIAL_USD: u64 = 100_000;
const INITIAL_BTC: u64 = 100_000;
const INITIAL_ETH: u64 = 1_000_000;
const INITIAL_VARA: u64 = 1_000_000_000;

/// The four (TokenKind, starting amount) pairs the DEX custodies.
fn kinds() -> [(TokenKind, u64); 4] {
    [
        (TokenKind::Usd, INITIAL_USD),
        (TokenKind::Btc, INITIAL_BTC),
        (TokenKind::Eth, INITIAL_ETH),
        (TokenKind::Vara, INITIAL_VARA),
    ]
}

async fn deploy() -> (GtestEnv, Actor<ThebookClientProgram, GtestEnv>) {
    let system = System::new();
    system.mint_to(ALICE, 100_000_000_000_000_000);
    system.mint_to(BOB, 100_000_000_000_000_000);
    let env = GtestEnv::new(system, ALICE.into());

    let code_id = env.system().submit_code(WASM_BINARY);
    let program = env
        .deploy::<ThebookClientProgram>(code_id, b"thebookdex".to_vec())
        .new()
        .await
        .unwrap();
    // The DEX sends VFT messages (deposit/withdraw) and must hold native balance to
    // cover the existential deposit reserved for each reply.
    env.system()
        .transfer(ALICE, program.id(), 10_000_000_000_000, false);

    // Deploy one mintable VFT per custodied balance and register it with the DEX.
    // Each token's faucet mints exactly the starting amount for its kind, so an
    // agent that claims + deposits once ends up with the canonical portfolio.
    let token_code = env.system().submit_code(TOKEN_WASM);
    let specs = [
        (
            TokenKind::Usd,
            "wUSDC",
            "wUSDC",
            INITIAL_USD,
            b"usd".to_vec(),
        ),
        (TokenKind::Btc, "wBTC", "wBTC", INITIAL_BTC, b"btc".to_vec()),
        (TokenKind::Eth, "wETH", "wETH", INITIAL_ETH, b"eth".to_vec()),
        (
            TokenKind::Vara,
            "wVARA",
            "wVARA",
            INITIAL_VARA,
            b"vara".to_vec(),
        ),
    ];
    for (kind, name, symbol, faucet, salt) in specs {
        let token = env
            .deploy::<ThebookTokenClientProgram>(token_code, salt)
            .new(name.to_string(), symbol.to_string(), 6, U256::from(faucet))
            .await
            .unwrap();
        let _: () = program
            .orderbook()
            .pending_call::<ob_io::SetToken>((kind, token.id()))
            .await
            .unwrap()
            .unwrap();
    }

    (env, program)
}

fn orderbook_svc(
    program: &Actor<ThebookClientProgram, GtestEnv>,
) -> Service<orderbook::OrderbookImpl, GtestEnv> {
    program.orderbook()
}

fn amm_svc(program: &Actor<ThebookClientProgram, GtestEnv>) -> Service<amm::AmmImpl, GtestEnv> {
    program.amm()
}

/// Fund `caller` to the canonical starting portfolio through the real onboarding:
/// claim each backing token from its faucet, approve the DEX, then deposit.
async fn fund(env: &GtestEnv, program: &Actor<ThebookClientProgram, GtestEnv>, caller: u64) {
    let dex = program.id();
    let (t_usd, t_btc, t_eth, t_vara): (ActorId, ActorId, ActorId, ActorId) = program
        .orderbook()
        .pending_call::<ob_io::GetTokens>(())
        .await
        .unwrap();
    let tokens = [t_usd, t_btc, t_eth, t_vara];
    let dex_actor =
        Actor::<ThebookClientProgram, GtestEnv>::new(env.clone().with_actor_id(caller.into()), dex);

    for (tid, (kind, amount)) in tokens.into_iter().zip(kinds()) {
        let token = Actor::<ThebookTokenClientProgram, GtestEnv>::new(
            env.clone().with_actor_id(caller.into()),
            tid,
        );
        let _: U256 = token
            .faucet()
            .pending_call::<tok_faucet_io::Claim>(())
            .await
            .unwrap()
            .unwrap();
        let _: bool = token
            .vft()
            .pending_call::<tok_vft_io::Approve>((dex, U256::from(amount)))
            .await
            .unwrap();
        let _: u64 = dex_actor
            .orderbook()
            .pending_call::<ob_io::Deposit>((kind, amount))
            .await
            .unwrap()
            .unwrap();
    }
}

/// Deposit the BTC/ETH/VARA basket (NOT usd) to `caller` via the faucet→deposit
/// onboarding. Join now funds USDT only, so tests that trade an asset first acquire
/// it here (the same way an agent would), which also restores the pre-change asset
/// balances the trade assertions are written against.
async fn give_assets(env: &GtestEnv, program: &Actor<ThebookClientProgram, GtestEnv>, caller: u64) {
    let dex = program.id();
    let (_t_usd, t_btc, t_eth, t_vara): (ActorId, ActorId, ActorId, ActorId) = program
        .orderbook()
        .pending_call::<ob_io::GetTokens>(())
        .await
        .unwrap();
    let dex_actor =
        Actor::<ThebookClientProgram, GtestEnv>::new(env.clone().with_actor_id(caller.into()), dex);
    let assets = [
        (t_btc, TokenKind::Btc, INITIAL_BTC),
        (t_eth, TokenKind::Eth, INITIAL_ETH),
        (t_vara, TokenKind::Vara, INITIAL_VARA),
    ];
    for (tid, kind, amount) in assets {
        let token = Actor::<ThebookTokenClientProgram, GtestEnv>::new(
            env.clone().with_actor_id(caller.into()),
            tid,
        );
        let _: U256 = token
            .faucet()
            .pending_call::<tok_faucet_io::Claim>(())
            .await
            .unwrap()
            .unwrap();
        let _: bool = token
            .vft()
            .pending_call::<tok_vft_io::Approve>((dex, U256::from(amount)))
            .await
            .unwrap();
        let _: u64 = dex_actor
            .orderbook()
            .pending_call::<ob_io::Deposit>((kind, amount))
            .await
            .unwrap()
            .unwrap();
    }
}

// Join funds USDT only; trading tests also acquire the asset basket via the faucet
// so they can sell/provide/​swap. (`join_raw` below joins without the assets, for the
// funding assertion itself.)
async fn join_alice(env: &GtestEnv, program: &Actor<ThebookClientProgram, GtestEnv>) {
    let _: (u64, u64, u64, u64) = orderbook_svc(program)
        .pending_call::<ob_io::Join>(("Alice".to_string(), AgentStrategy::ArbitrageHunter))
        .await
        .unwrap();
    give_assets(env, program, ALICE).await;
}

async fn join_bob(env: &GtestEnv, program: &Actor<ThebookClientProgram, GtestEnv>) {
    let _: (u64, u64, u64, u64) = orderbook_svc(program)
        .pending_call::<ob_io::Join>(("Bob".to_string(), AgentStrategy::MarketMaker))
        .await
        .unwrap();
    give_assets(env, program, BOB).await;
}

// ── Orderbook tests ──

#[tokio::test]
async fn join_creates_agent() {
    let (env, program) = deploy().await;
    let _ = env;
    // Raw join (no asset top-up): verify the on-chain funding grants USDT only.
    let _: (u64, u64, u64, u64) = orderbook_svc(&program)
        .pending_call::<ob_io::Join>(("Alice".to_string(), AgentStrategy::ArbitrageHunter))
        .await
        .unwrap();

    let port: (u64, u64, u64, u64) = orderbook_svc(&program)
        .pending_call::<ob_io::GetPortfolio>(())
        .await
        .unwrap();
    // Join now funds USDT only; assets are acquired by trading, not granted.
    assert_eq!(port, (1_000_000_000, 0, 0, 0));
}

#[tokio::test]
async fn seed_house_grants_stockpile_admin_only() {
    let (env, program) = deploy().await;
    // Admin (the deployer / default actor) joins USDT-only, then claims the house
    // stockpile once for deep market-maker inventory.
    let _: (u64, u64, u64, u64) = orderbook_svc(&program)
        .pending_call::<ob_io::Join>(("House".to_string(), AgentStrategy::MarketMaker))
        .await
        .unwrap();
    let expected = (1_000_000_000 + 10_000_000_000_000, 100_000_000u64, 1_000_000_000u64, 100_000_000_000u64);
    let seeded: Result<(u64, u64, u64, u64), ContractError> = orderbook_svc(&program)
        .pending_call::<ob_io::SeedHouse>(())
        .await
        .unwrap();
    assert_eq!(seeded.unwrap(), expected);
    // Idempotent: a second call does not double the stockpile.
    let again: Result<(u64, u64, u64, u64), ContractError> = orderbook_svc(&program)
        .pending_call::<ob_io::SeedHouse>(())
        .await
        .unwrap();
    assert_eq!(again.unwrap(), expected);
    // Non-admin is rejected.
    let bob = Actor::new(env.clone().with_actor_id(BOB.into()), program.id());
    let _: (u64, u64, u64, u64) = orderbook_svc(&bob)
        .pending_call::<ob_io::Join>(("Bob".to_string(), AgentStrategy::MarketMaker))
        .await
        .unwrap();
    let denied: Result<(u64, u64, u64, u64), ContractError> = orderbook_svc(&bob)
        .pending_call::<ob_io::SeedHouse>(())
        .await
        .unwrap();
    assert!(denied.is_err(), "non-admin must not seed the house");
}

#[tokio::test]
async fn join_sets_identity() {
    let (env, program) = deploy().await;
    join_alice(&env, &program).await;

    let id: Option<(String, AgentStrategy)> = orderbook_svc(&program)
        .pending_call::<ob_io::GetIdentity>(())
        .await
        .unwrap();
    assert_eq!(
        id,
        Some(("Alice".to_string(), AgentStrategy::ArbitrageHunter))
    );

    let board: Vec<LeaderEntry> = orderbook_svc(&program)
        .pending_call::<ob_io::GetLeaderboard>((10u32,))
        .await
        .unwrap();
    assert_eq!(board.len(), 1);
    assert_eq!(board[0].name, "Alice");
    assert_eq!(board[0].strategy, AgentStrategy::ArbitrageHunter);
}

#[tokio::test]
async fn place_limit_buy_then_cancel() {
    let (env, program) = deploy().await;
    join_alice(&env, &program).await;

    let oid: u64 = orderbook_svc(&program)
        .pending_call::<ob_io::PlaceLimit>((Side::Buy, Asset::BTC, 5_000_000, 1))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(oid, 0); // first order has ID 0

    let _: () = orderbook_svc(&program)
        .pending_call::<ob_io::CancelOrder>((oid,))
        .await
        .unwrap()
        .unwrap();

    let port: (u64, u64, u64, u64) = orderbook_svc(&program)
        .pending_call::<ob_io::GetPortfolio>(())
        .await
        .unwrap();
    assert_eq!(port.0, 1_000_000_000);
}

#[tokio::test]
async fn place_limit_sell_then_cancel() {
    let (env, program) = deploy().await;
    join_alice(&env, &program).await;

    let oid: u64 = orderbook_svc(&program)
        .pending_call::<ob_io::PlaceLimit>((Side::Sell, Asset::BTC, 6_000_000, 1))
        .await
        .unwrap()
        .unwrap();

    let _: () = orderbook_svc(&program)
        .pending_call::<ob_io::CancelOrder>((oid,))
        .await
        .unwrap()
        .unwrap();

    let port: (u64, u64, u64, u64) = orderbook_svc(&program)
        .pending_call::<ob_io::GetPortfolio>(())
        .await
        .unwrap();
    assert_eq!(port.1, 100_000);
}

// Regression: cancelling must REMOVE the order from state, not just mark it Cancelled.
// A market maker that re-quotes every move cancels constantly; if cancels left dead
// entries behind, the MAX_OPEN_ORDERS (500) cap would fill with corpses and lock the
// whole book into BookFull (which is exactly what took the live book down). Placing +
// cancelling well past the cap must keep working, and leave the book empty at the end.
#[tokio::test]
async fn cancel_prunes_orders_no_bookfull() {
    let (env, program) = deploy().await;
    join_alice(&env, &program).await;

    for _ in 0..560u32 {
        let oid: u64 = orderbook_svc(&program)
            .pending_call::<ob_io::PlaceLimit>((Side::Sell, Asset::BTC, 6_000_000, 1))
            .await
            .unwrap()
            .unwrap();
        let _: () = orderbook_svc(&program)
            .pending_call::<ob_io::CancelOrder>((oid,))
            .await
            .unwrap()
            .unwrap();
    }

    // The book is back to empty and still accepts orders after 560 place/cancel cycles.
    let (_, _, orders_len, _, _): (u32, u64, u32, bool, u32) = orderbook_svc(&program)
        .pending_call::<ob_io::GetStatus>(())
        .await
        .unwrap();
    assert_eq!(orders_len, 0, "cancelled orders were not pruned from state");
    let _: u64 = orderbook_svc(&program)
        .pending_call::<ob_io::PlaceLimit>((Side::Sell, Asset::BTC, 6_000_000, 1))
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn market_buy_fills_sell_order() {
    let (env, program) = deploy().await;
    join_alice(&env, &program).await;

    let _: u64 = orderbook_svc(&program)
        .pending_call::<ob_io::PlaceLimit>((Side::Sell, Asset::BTC, 5_000_000, 2))
        .await
        .unwrap()
        .unwrap();

    let pid = program.id();
    let bob = Actor::new(env.clone().with_actor_id(BOB.into()), pid);
    join_bob(&env, &bob).await;

    let _: String = orderbook_svc(&bob)
        .pending_call::<ob_io::MarketBuy>((Asset::BTC, 1))
        .await
        .unwrap()
        .unwrap();

    let port: (u64, u64, u64, u64) = orderbook_svc(&bob)
        .pending_call::<ob_io::GetPortfolio>(())
        .await
        .unwrap();
    assert_eq!(port.1, 100_001);
}

#[tokio::test]
async fn market_sell_fills_buy_order() {
    let (env, program) = deploy().await;
    join_alice(&env, &program).await;

    let _: u64 = orderbook_svc(&program)
        .pending_call::<ob_io::PlaceLimit>((Side::Buy, Asset::BTC, 5_000_000, 2))
        .await
        .unwrap()
        .unwrap();

    let pid = program.id();
    let bob = Actor::new(env.clone().with_actor_id(BOB.into()), pid);
    join_bob(&env, &bob).await;

    let _: String = orderbook_svc(&bob)
        .pending_call::<ob_io::MarketSell>((Asset::BTC, 1))
        .await
        .unwrap()
        .unwrap();

    let port: (u64, u64, u64, u64) = orderbook_svc(&bob)
        .pending_call::<ob_io::GetPortfolio>(())
        .await
        .unwrap();
    assert_eq!(port.1, 99_999);
}

// Regression: a resting limit-buy escrows USD at placement, so when it is later
// filled by an incoming sell the buyer must NOT be charged again. Alice buys 2 BTC
// @ 50 (escrows 100), Bob market-sells 1 into it: Alice gains 1 BTC and her USD must
// stay at 99_900 (100_000 - 100 escrow), not drop a further 50.
#[tokio::test]
async fn resting_buy_not_double_charged_on_market_sell() {
    let (env, program) = deploy().await;
    join_alice(&env, &program).await;

    let _: u64 = orderbook_svc(&program)
        .pending_call::<ob_io::PlaceLimit>((Side::Buy, Asset::BTC, 5_000_000, 2))
        .await
        .unwrap()
        .unwrap();

    let bob = Actor::new(env.clone().with_actor_id(BOB.into()), program.id());
    join_bob(&env, &bob).await;
    let _: String = orderbook_svc(&bob)
        .pending_call::<ob_io::MarketSell>((Asset::BTC, 1))
        .await
        .unwrap()
        .unwrap();

    let port: (u64, u64, u64, u64) = orderbook_svc(&program)
        .pending_call::<ob_io::GetPortfolio>(())
        .await
        .unwrap();
    assert_eq!(port.0, 999_999_900, "resting buyer USD double-charged");
    assert_eq!(port.1, 100_001, "resting buyer did not receive bought BTC");
}

// Regression: same invariant for the incoming-limit-sell match path (place_limit,
// Side::Sell) rather than the market_sell path.
#[tokio::test]
async fn resting_buy_not_double_charged_on_limit_sell() {
    let (env, program) = deploy().await;
    join_alice(&env, &program).await;

    let _: u64 = orderbook_svc(&program)
        .pending_call::<ob_io::PlaceLimit>((Side::Buy, Asset::BTC, 5_000_000, 2))
        .await
        .unwrap()
        .unwrap();

    let bob = Actor::new(env.clone().with_actor_id(BOB.into()), program.id());
    join_bob(&env, &bob).await;
    let _: u64 = orderbook_svc(&bob)
        .pending_call::<ob_io::PlaceLimit>((Side::Sell, Asset::BTC, 5_000_000, 1))
        .await
        .unwrap()
        .unwrap();

    let port: (u64, u64, u64, u64) = orderbook_svc(&program)
        .pending_call::<ob_io::GetPortfolio>(())
        .await
        .unwrap();
    assert_eq!(port.0, 999_999_900, "resting buyer USD double-charged");
    assert_eq!(port.1, 100_001, "resting buyer did not receive bought BTC");
}

// ── AMM tests ──

#[tokio::test]
async fn amm_create_pool_works() {
    let (env, program) = deploy().await;
    join_alice(&env, &program).await;

    let pool_id: u64 = amm_svc(&program)
        .pending_call::<amm_io::CreatePool>((Asset::BTC, Asset::ETH))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(pool_id, 0); // first pool has ID 0

    let pool: Option<Pool> = amm_svc(&program)
        .pending_call::<amm_io::GetPool>((pool_id,))
        .await
        .unwrap();
    assert!(pool.is_some());
    let pool = pool.unwrap();
    assert_eq!(pool.id, 0);
    assert_eq!(pool.asset_a, Asset::BTC);
    assert_eq!(pool.asset_b, Asset::ETH);
}

#[tokio::test]
async fn amm_same_asset_pool_fails() {
    let (env, program) = deploy().await;
    join_alice(&env, &program).await;

    let result: Result<Result<u64, ContractError>, GtestError> = amm_svc(&program)
        .pending_call::<amm_io::CreatePool>((Asset::BTC, Asset::BTC))
        .await;
    match result {
        Ok(Err(_)) => {}
        _ => panic!("expected ContractError"),
    }
}

#[tokio::test]
async fn amm_add_liquidity_works() {
    let (env, program) = deploy().await;
    join_alice(&env, &program).await;

    let pool_id: u64 = amm_svc(&program)
        .pending_call::<amm_io::CreatePool>((Asset::BTC, Asset::ETH))
        .await
        .unwrap()
        .unwrap();

    let lp: u64 = amm_svc(&program)
        .pending_call::<amm_io::AddLiquidity>((pool_id, 5, 50))
        .await
        .unwrap()
        .unwrap();
    assert!(lp > 0);

    let pool: Pool = amm_svc(&program)
        .pending_call::<amm_io::GetPool>((pool_id,))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(pool.reserve_a, 5);
    assert_eq!(pool.reserve_b, 50);

    let port: (u64, u64, u64, u64) = orderbook_svc(&program)
        .pending_call::<ob_io::GetPortfolio>(())
        .await
        .unwrap();
    assert_eq!(port.1, 100_000 - 5);
    assert_eq!(port.2, 1_000_000 - 50);
}

#[tokio::test]
async fn amm_swap_executes() {
    let (env, program) = deploy().await;
    join_alice(&env, &program).await;

    let pool_id: u64 = amm_svc(&program)
        .pending_call::<amm_io::CreatePool>((Asset::BTC, Asset::ETH))
        .await
        .unwrap()
        .unwrap();

    let _: u64 = amm_svc(&program)
        .pending_call::<amm_io::AddLiquidity>((pool_id, 10, 100))
        .await
        .unwrap()
        .unwrap();

    let pid = program.id();
    let bob = Actor::new(env.clone().with_actor_id(BOB.into()), pid);
    join_bob(&env, &bob).await;

    let amount_out: u64 = amm_svc(&bob)
        .pending_call::<amm_io::Swap>((pool_id, Asset::BTC, 1, 1))
        .await
        .unwrap()
        .unwrap();
    assert!(amount_out > 0);

    let port: (u64, u64, u64, u64) = orderbook_svc(&bob)
        .pending_call::<ob_io::GetPortfolio>(())
        .await
        .unwrap();
    assert_eq!(port.1, 100_000 - 1);
    assert!(port.2 > 1_000_000);
}

// Regression: the swap fee must stay in the pool (credited to LPs via a growing k),
// not be destroyed. Bob swaps 1000 BTC in (fee = 1000*3/1000 = 3). The BTC reserve
// must grow by the FULL 1000, not by 997.
#[tokio::test]
async fn swap_fee_accrues_to_pool_reserves() {
    let (env, program) = deploy().await;
    join_alice(&env, &program).await;

    let pool_id: u64 = amm_svc(&program)
        .pending_call::<amm_io::CreatePool>((Asset::BTC, Asset::ETH))
        .await
        .unwrap()
        .unwrap();
    let _: u64 = amm_svc(&program)
        .pending_call::<amm_io::AddLiquidity>((pool_id, 10_000, 100_000))
        .await
        .unwrap()
        .unwrap();

    let bob = Actor::new(env.clone().with_actor_id(BOB.into()), program.id());
    join_bob(&env, &bob).await;
    let amount_out: u64 = amm_svc(&bob)
        .pending_call::<amm_io::Swap>((pool_id, Asset::BTC, 1000, 1))
        .await
        .unwrap()
        .unwrap();

    let pool: Pool = amm_svc(&program)
        .pending_call::<amm_io::GetPool>((pool_id,))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(pool.reserve_a, 11_000, "swap fee not retained in pool");
    assert_eq!(pool.reserve_b, 100_000 - amount_out);
}

#[tokio::test]
async fn amm_remove_liquidity_works() {
    let (env, program) = deploy().await;
    join_alice(&env, &program).await;

    let pool_id: u64 = amm_svc(&program)
        .pending_call::<amm_io::CreatePool>((Asset::BTC, Asset::ETH))
        .await
        .unwrap()
        .unwrap();

    let lp: u64 = amm_svc(&program)
        .pending_call::<amm_io::AddLiquidity>((pool_id, 5, 50))
        .await
        .unwrap()
        .unwrap();

    let (a_out, b_out): (u64, u64) = amm_svc(&program)
        .pending_call::<amm_io::RemoveLiquidity>((pool_id, lp))
        .await
        .unwrap()
        .unwrap();
    assert!(a_out > 0);
    assert!(b_out > 0);

    let port: (u64, u64, u64, u64) = orderbook_svc(&program)
        .pending_call::<ob_io::GetPortfolio>(())
        .await
        .unwrap();
    assert_eq!(port.1, 100_000);
    assert_eq!(port.2, 1_000_000);
}

#[tokio::test]
async fn list_pools_after_creation() {
    let (env, program) = deploy().await;
    join_alice(&env, &program).await;

    let _: u64 = amm_svc(&program)
        .pending_call::<amm_io::CreatePool>((Asset::BTC, Asset::ETH))
        .await
        .unwrap()
        .unwrap();

    let pools: Vec<Pool> = amm_svc(&program)
        .pending_call::<amm_io::ListPools>(())
        .await
        .unwrap();
    assert_eq!(pools.len(), 1);
    assert_eq!(pools[0].asset_a, Asset::BTC);
}

#[tokio::test]
async fn swap_insufficient_balance_fails() {
    let (env, program) = deploy().await;
    join_alice(&env, &program).await;

    let pool_id: u64 = amm_svc(&program)
        .pending_call::<amm_io::CreatePool>((Asset::BTC, Asset::ETH))
        .await
        .unwrap()
        .unwrap();

    let _: u64 = amm_svc(&program)
        .pending_call::<amm_io::AddLiquidity>((pool_id, 10, 100))
        .await
        .unwrap()
        .unwrap();

    let pid = program.id();
    let bob = Actor::new(env.clone().with_actor_id(BOB.into()), pid);
    join_bob(&env, &bob).await;

    let result: Result<Result<u64, ContractError>, GtestError> = amm_svc(&bob)
        .pending_call::<amm_io::Swap>((pool_id, Asset::BTC, 999_999, 1))
        .await;
    match result {
        Ok(Err(ContractError::InsufficientAsset)) => {}
        _ => panic!("expected InsufficientAsset"),
    }
}

#[tokio::test]
async fn swap_slippage_protection() {
    let (env, program) = deploy().await;
    join_alice(&env, &program).await;

    let pool_id: u64 = amm_svc(&program)
        .pending_call::<amm_io::CreatePool>((Asset::BTC, Asset::ETH))
        .await
        .unwrap()
        .unwrap();

    let _: u64 = amm_svc(&program)
        .pending_call::<amm_io::AddLiquidity>((pool_id, 10, 100))
        .await
        .unwrap()
        .unwrap();

    let result: Result<Result<u64, ContractError>, GtestError> = amm_svc(&program)
        .pending_call::<amm_io::Swap>((pool_id, Asset::BTC, 1, 100))
        .await;
    match result {
        Ok(Err(ContractError::SlippageExceeded)) => {}
        _ => panic!("expected SlippageExceeded"),
    }
}

#[tokio::test]
async fn full_dex_scenario() {
    let (env, program) = deploy().await;
    let pid = program.id();
    join_alice(&env, &program).await;

    // ALICE: sell 1 BTC at $50 on orderbook
    let _: u64 = orderbook_svc(&program)
        .pending_call::<ob_io::PlaceLimit>((Side::Sell, Asset::BTC, 5_000_000, 1))
        .await
        .unwrap()
        .unwrap();

    // ALICE: create AMM pool BTC/ETH and add liquidity
    let pool_id: u64 = amm_svc(&program)
        .pending_call::<amm_io::CreatePool>((Asset::BTC, Asset::ETH))
        .await
        .unwrap()
        .unwrap();
    let _: u64 = amm_svc(&program)
        .pending_call::<amm_io::AddLiquidity>((pool_id, 10, 100))
        .await
        .unwrap()
        .unwrap();

    // BOB: market buy 1 BTC from orderbook, then swap 1 BTC for ETH via AMM
    let bob = Actor::new(env.clone().with_actor_id(BOB.into()), pid);
    join_bob(&env, &bob).await;

    let _: String = orderbook_svc(&bob)
        .pending_call::<ob_io::MarketBuy>((Asset::BTC, 1))
        .await
        .unwrap()
        .unwrap();

    let port: (u64, u64, u64, u64) = orderbook_svc(&bob)
        .pending_call::<ob_io::GetPortfolio>(())
        .await
        .unwrap();
    assert_eq!(port.1, 100_001);

    let eth_out: u64 = amm_svc(&bob)
        .pending_call::<amm_io::Swap>((pool_id, Asset::BTC, 1, 1))
        .await
        .unwrap()
        .unwrap();
    assert!(eth_out > 0);

    let port: (u64, u64, u64, u64) = orderbook_svc(&bob)
        .pending_call::<ob_io::GetPortfolio>(())
        .await
        .unwrap();
    assert_eq!(port.1, 100_000);
    assert!(port.2 > 1_000_000);
}

// ── Regression tests for launch-hardening fixes ──

/// A market buy the caller cannot afford must leave BOTH sides untouched.
/// Previously the matching loop credited sellers and filled orders before the
/// USD check, so an `InsufficientUsd` error still committed those mutations.
#[tokio::test]
async fn market_buy_insufficient_usd_does_not_mutate_state() {
    let (env, program) = deploy().await;
    join_alice(&env, &program).await;

    // Alice offers 1 BTC at a price Bob cannot cover (Bob starts with 1e9 micro-USD
    // = $1,000; this ask's notional is $20,000).
    let _: u64 = orderbook_svc(&program)
        .pending_call::<ob_io::PlaceLimit>((Side::Sell, Asset::BTC, 2_000_000_000_000_000, 1))
        .await
        .unwrap()
        .unwrap();
    let alice_before: (u64, u64, u64, u64) = orderbook_svc(&program)
        .pending_call::<ob_io::GetPortfolio>(())
        .await
        .unwrap();

    let pid = program.id();
    let bob = Actor::new(env.clone().with_actor_id(BOB.into()), pid);
    join_bob(&env, &bob).await;
    let bob_before: (u64, u64, u64, u64) = orderbook_svc(&bob)
        .pending_call::<ob_io::GetPortfolio>(())
        .await
        .unwrap();

    let result: Result<Result<String, ContractError>, GtestError> = orderbook_svc(&bob)
        .pending_call::<ob_io::MarketBuy>((Asset::BTC, 1))
        .await;
    match result {
        Ok(Err(ContractError::InsufficientUsd)) => {}
        other => panic!("expected InsufficientUsd, got {other:?}"),
    }

    let alice_after: (u64, u64, u64, u64) = orderbook_svc(&program)
        .pending_call::<ob_io::GetPortfolio>(())
        .await
        .unwrap();
    let bob_after: (u64, u64, u64, u64) = orderbook_svc(&bob)
        .pending_call::<ob_io::GetPortfolio>(())
        .await
        .unwrap();
    assert_eq!(
        alice_before, alice_after,
        "seller was credited despite failed buy"
    );
    assert_eq!(
        bob_before, bob_after,
        "buyer state changed despite failed buy"
    );
}

/// Adding liquidity twice must merge into one position so the full LP can be
/// removed in a single call. Previously the second add pushed a duplicate entry
/// and remove only saw the first, stranding the rest.
#[tokio::test]
async fn double_add_liquidity_then_remove_all() {
    let (env, program) = deploy().await;
    join_alice(&env, &program).await;

    let pool_id: u64 = amm_svc(&program)
        .pending_call::<amm_io::CreatePool>((Asset::BTC, Asset::ETH))
        .await
        .unwrap()
        .unwrap();

    let lp1: u64 = amm_svc(&program)
        .pending_call::<amm_io::AddLiquidity>((pool_id, 10, 100))
        .await
        .unwrap()
        .unwrap();
    let lp2: u64 = amm_svc(&program)
        .pending_call::<amm_io::AddLiquidity>((pool_id, 5, 50))
        .await
        .unwrap()
        .unwrap();

    // Removing the combined LP must succeed and return all deposited assets.
    let (a_out, b_out): (u64, u64) = amm_svc(&program)
        .pending_call::<amm_io::RemoveLiquidity>((pool_id, lp1 + lp2))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(a_out, 15);
    assert_eq!(b_out, 150);

    let port: (u64, u64, u64, u64) = orderbook_svc(&program)
        .pending_call::<ob_io::GetPortfolio>(())
        .await
        .unwrap();
    assert_eq!(port.1, 100_000, "BTC not fully restored");
    assert_eq!(port.2, 1_000_000, "ETH not fully restored");
}

// ── Vault (real-token) integration tests ──

/// End-to-end: after the faucet→deposit onboarding, the DEX vault actually holds
/// the caller's tokens, and `withdraw` sends real VFT back and debits the internal
/// balance. Proves the internal balance is fully token-backed, not simulated.
#[tokio::test]
async fn deposit_then_withdraw_round_trip() {
    let (env, program) = deploy().await;
    // Raw join funds USDT only (no faucet claim), so the single `fund()` below is
    // the one and only faucet -> approve -> deposit custody flow: USDT ends at the
    // join grant (1e9 micro) plus its 100_000 deposit, and each asset is one deposit.
    let _: (u64, u64, u64, u64) = orderbook_svc(&program)
        .pending_call::<ob_io::Join>(("Alice".to_string(), AgentStrategy::ArbitrageHunter))
        .await
        .unwrap();
    fund(&env, &program, ALICE).await;

    let port: (u64, u64, u64, u64) = orderbook_svc(&program)
        .pending_call::<ob_io::GetPortfolio>(())
        .await
        .unwrap();
    assert_eq!(port, (1_000_100_000, 100_000, 1_000_000, 1_000_000_000));

    // The wBTC token program holds the deposited BTC in the DEX's account, and
    // Alice's own token balance is zero (she deposited all of it).
    let (_, t_btc, _, _): (ActorId, ActorId, ActorId, ActorId) = orderbook_svc(&program)
        .pending_call::<ob_io::GetTokens>(())
        .await
        .unwrap();
    let btc = Actor::<ThebookTokenClientProgram, GtestEnv>::new(
        env.clone().with_actor_id(ALICE.into()),
        t_btc,
    );
    let dex_held: U256 = btc
        .vft()
        .pending_call::<tok_vft_io::BalanceOf>((program.id(),))
        .await
        .unwrap();
    assert_eq!(dex_held, U256::from(INITIAL_BTC), "vault does not hold BTC");
    let alice_wallet: U256 = btc
        .vft()
        .pending_call::<tok_vft_io::BalanceOf>((ALICE.into(),))
        .await
        .unwrap();
    assert_eq!(
        alice_wallet,
        U256::zero(),
        "Alice should have deposited all"
    );

    // Withdraw 40_000 BTC back to Alice's wallet.
    let out: u64 = orderbook_svc(&program)
        .pending_call::<ob_io::Withdraw>((TokenKind::Btc, 40_000u64))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(out, 40_000);

    let port: (u64, u64, u64, u64) = orderbook_svc(&program)
        .pending_call::<ob_io::GetPortfolio>(())
        .await
        .unwrap();
    // Started at 100_000 internal BTC (one faucet deposit), withdrew 40_000.
    assert_eq!(port.1, 60_000, "internal BTC not debited on withdraw");
    let alice_wallet: U256 = btc
        .vft()
        .pending_call::<tok_vft_io::BalanceOf>((ALICE.into(),))
        .await
        .unwrap();
    assert_eq!(
        alice_wallet,
        U256::from(40_000u64),
        "withdrawn tokens not received"
    );
}

/// Withdrawing more than the internal balance must fail cleanly and leave both the
/// internal balance and the on-chain vault untouched.
#[tokio::test]
async fn withdraw_over_balance_fails() {
    let (env, program) = deploy().await;
    join_alice(&env, &program).await;

    let result: Result<Result<u64, ContractError>, GtestError> = orderbook_svc(&program)
        .pending_call::<ob_io::Withdraw>((TokenKind::Btc, 100_001u64))
        .await;
    match result {
        Ok(Err(ContractError::InsufficientAsset)) => {}
        other => panic!("expected InsufficientAsset, got {other:?}"),
    }

    let port: (u64, u64, u64, u64) = orderbook_svc(&program)
        .pending_call::<ob_io::GetPortfolio>(())
        .await
        .unwrap();
    assert_eq!(port.1, 100_000, "balance changed on failed withdraw");
}

/// Deposit/withdraw are gated on the token being registered. A fresh DEX with no
/// token wired up must reject deposits rather than credit unbacked balances.
#[tokio::test]
async fn deposit_unregistered_token_fails() {
    let system = System::new();
    system.mint_to(ALICE, 100_000_000_000_000_000);
    let env = GtestEnv::new(system, ALICE.into());
    let code_id = env.system().submit_code(WASM_BINARY);
    let program = env
        .deploy::<ThebookClientProgram>(code_id, b"bare".to_vec())
        .new()
        .await
        .unwrap();
    let _: (u64, u64, u64, u64) = orderbook_svc(&program)
        .pending_call::<ob_io::Join>(("Alice".to_string(), AgentStrategy::ArbitrageHunter))
        .await
        .unwrap();

    let result: Result<Result<u64, ContractError>, GtestError> = orderbook_svc(&program)
        .pending_call::<ob_io::Deposit>((TokenKind::Btc, 100u64))
        .await;
    match result {
        Ok(Err(ContractError::BadParams)) => {}
        other => panic!("expected BadParams, got {other:?}"),
    }
}

// ── Edge-case / robustness tests ──

#[tokio::test]
async fn deposit_zero_amount_fails() {
    let (env, program) = deploy().await;
    join_alice(&env, &program).await;

    let result: Result<Result<u64, ContractError>, GtestError> = orderbook_svc(&program)
        .pending_call::<ob_io::Deposit>((TokenKind::Btc, 0u64))
        .await;
    match result {
        Ok(Err(ContractError::ZeroAmount)) => {}
        other => panic!("expected ZeroAmount, got {other:?}"),
    }
}

#[tokio::test]
async fn withdraw_zero_amount_fails() {
    let (env, program) = deploy().await;
    join_alice(&env, &program).await;

    let result: Result<Result<u64, ContractError>, GtestError> = orderbook_svc(&program)
        .pending_call::<ob_io::Withdraw>((TokenKind::Btc, 0u64))
        .await;
    match result {
        Ok(Err(ContractError::ZeroAmount)) => {}
        other => panic!("expected ZeroAmount, got {other:?}"),
    }
}

#[tokio::test]
async fn place_limit_zero_price_fails() {
    let (env, program) = deploy().await;
    join_alice(&env, &program).await;

    let result: Result<Result<u64, ContractError>, GtestError> = orderbook_svc(&program)
        .pending_call::<ob_io::PlaceLimit>((Side::Buy, Asset::BTC, 0u64, 1u64))
        .await;
    match result {
        Ok(Err(ContractError::BadParams)) => {}
        other => panic!("expected BadParams, got {other:?}"),
    }
}

/// Non-admin callers cannot re-point a token address (guards the vault backing).
#[tokio::test]
async fn set_token_non_admin_fails() {
    let (env, program) = deploy().await;
    join_alice(&env, &program).await;

    let bob = Actor::new(env.clone().with_actor_id(BOB.into()), program.id());
    let result: Result<Result<(), ContractError>, GtestError> = bob
        .orderbook()
        .pending_call::<ob_io::SetToken>((TokenKind::Btc, BOB.into()))
        .await;
    match result {
        Ok(Err(ContractError::NotAdmin)) => {}
        other => panic!("expected NotAdmin, got {other:?}"),
    }
}

// ── Perpetual futures tests ──

// A test mark in micro-dollars ($1 = 1e6). The exact dollar value is immaterial —
// the perp assertions are all relative (PnL sign, payout vs margin, reserve delta).
const BTC_MARK: u64 = 6_420_800;

fn perps_svc(
    program: &Actor<ThebookClientProgram, GtestEnv>,
) -> Service<perps::PerpsImpl, GtestEnv> {
    program.perps()
}

/// Fund Alice, publish a BTC mark, and seed the house reserve. Returns nothing;
/// Alice is admin (deployer) so she can set marks and fund the reserve.
async fn setup_perps(env: &GtestEnv, program: &Actor<ThebookClientProgram, GtestEnv>) {
    join_alice(env, program).await;
    let _: () = perps_svc(program)
        .pending_call::<perp_io::SetMarkPrice>((Asset::BTC, BTC_MARK))
        .await
        .unwrap()
        .unwrap();
    // Seed reserve with $500 (50_000 cents) so winners can be paid.
    let _: u64 = perps_svc(program)
        .pending_call::<perp_io::FundReserve>((50_000u64,))
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn perp_open_close_flat_returns_margin() {
    let (env, program) = deploy().await;
    setup_perps(&env, &program).await;

    let _: u64 = perps_svc(&program)
        .pending_call::<perp_io::OpenPosition>((Asset::BTC, true, 10_000u64, 2u32))
        .await
        .unwrap()
        .unwrap();

    // Close at the same mark: PnL is 0, payout equals the margin, reserve untouched.
    let (payout, pnl): (u64, i64) = perps_svc(&program)
        .pending_call::<perp_io::ClosePosition>((Asset::BTC,))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(pnl, 0);
    assert_eq!(payout, 10_000);
    let reserve: u64 = perps_svc(&program)
        .pending_call::<perp_io::GetReserve>(())
        .await
        .unwrap();
    assert_eq!(reserve, 50_000, "flat close must not touch reserve");
}

#[tokio::test]
async fn perp_long_profit_paid_from_reserve() {
    let (env, program) = deploy().await;
    setup_perps(&env, &program).await;

    let _: u64 = perps_svc(&program)
        .pending_call::<perp_io::OpenPosition>((Asset::BTC, true, 10_000u64, 5u32))
        .await
        .unwrap()
        .unwrap();

    // Mark rises ~10% → long is in profit.
    let _: () = perps_svc(&program)
        .pending_call::<perp_io::SetMarkPrice>((Asset::BTC, 7_062_880u64))
        .await
        .unwrap()
        .unwrap();

    let (payout, pnl): (u64, i64) = perps_svc(&program)
        .pending_call::<perp_io::ClosePosition>((Asset::BTC,))
        .await
        .unwrap()
        .unwrap();
    assert!(pnl > 0, "long should profit on a price rise");
    assert!(payout > 10_000, "payout should exceed margin");
    let reserve: u64 = perps_svc(&program)
        .pending_call::<perp_io::GetReserve>(())
        .await
        .unwrap();
    assert!(reserve < 50_000, "profit must be paid from the reserve");
    assert_eq!(reserve as i64, 50_000 - pnl, "reserve delta must equal PnL");
}

#[tokio::test]
async fn perp_short_loss_grows_reserve() {
    let (env, program) = deploy().await;
    setup_perps(&env, &program).await;

    let _: u64 = perps_svc(&program)
        .pending_call::<perp_io::OpenPosition>((Asset::BTC, false, 10_000u64, 5u32))
        .await
        .unwrap()
        .unwrap();

    // Mark rises → short loses.
    let _: () = perps_svc(&program)
        .pending_call::<perp_io::SetMarkPrice>((Asset::BTC, 6_741_840u64))
        .await
        .unwrap()
        .unwrap();

    let (payout, pnl): (u64, i64) = perps_svc(&program)
        .pending_call::<perp_io::ClosePosition>((Asset::BTC,))
        .await
        .unwrap()
        .unwrap();
    assert!(pnl < 0, "short should lose on a price rise");
    assert!(payout < 10_000, "payout should be less than margin");
    let reserve: u64 = perps_svc(&program)
        .pending_call::<perp_io::GetReserve>(())
        .await
        .unwrap();
    assert_eq!(
        reserve as i64,
        50_000 + (-pnl),
        "reserve should absorb the loss"
    );
}

#[tokio::test]
async fn perp_liquidation_flow() {
    let (env, program) = deploy().await;
    setup_perps(&env, &program).await;

    // 20x long: a modest adverse move wipes the margin.
    let _: u64 = perps_svc(&program)
        .pending_call::<perp_io::OpenPosition>((Asset::BTC, true, 10_000u64, 20u32))
        .await
        .unwrap()
        .unwrap();

    // Healthy position is not liquidatable.
    let bob = Actor::new(env.clone().with_actor_id(BOB.into()), program.id());
    let early: Result<Result<(), ContractError>, GtestError> = bob
        .perps()
        .pending_call::<perp_io::Liquidate>((ALICE.into(), Asset::BTC))
        .await;
    match early {
        Ok(Err(ContractError::NotLiquidatable)) => {}
        other => panic!("expected NotLiquidatable, got {other:?}"),
    }

    // Mark drops ~6.5% → equity falls below maintenance.
    let _: () = perps_svc(&program)
        .pending_call::<perp_io::SetMarkPrice>((Asset::BTC, 6_000_000u64))
        .await
        .unwrap()
        .unwrap();

    let _: () = bob
        .perps()
        .pending_call::<perp_io::Liquidate>((ALICE.into(), Asset::BTC))
        .await
        .unwrap()
        .unwrap();

    // Position is gone.
    let positions: Vec<(Asset, bool, u64, u64, u64, u32, i64)> = perps_svc(&program)
        .pending_call::<perp_io::GetPositions>((ALICE.into(),))
        .await
        .unwrap();
    assert!(positions.is_empty(), "liquidated position must be removed");
}

#[tokio::test]
async fn perp_leverage_cap_enforced() {
    let (env, program) = deploy().await;
    setup_perps(&env, &program).await;

    let result: Result<Result<u64, ContractError>, GtestError> = perps_svc(&program)
        .pending_call::<perp_io::OpenPosition>((Asset::BTC, true, 10_000u64, 50u32))
        .await;
    match result {
        Ok(Err(ContractError::LeverageTooHigh)) => {}
        other => panic!("expected LeverageTooHigh, got {other:?}"),
    }
}

#[tokio::test]
async fn perp_set_mark_price_non_admin_fails() {
    let (env, program) = deploy().await;
    join_alice(&env, &program).await;

    let bob = Actor::new(env.clone().with_actor_id(BOB.into()), program.id());
    let result: Result<Result<(), ContractError>, GtestError> = bob
        .perps()
        .pending_call::<perp_io::SetMarkPrice>((Asset::BTC, BTC_MARK))
        .await;
    match result {
        Ok(Err(ContractError::NotAdmin)) => {}
        other => panic!("expected NotAdmin, got {other:?}"),
    }
}

/// A mark that hasn't been refreshed within MAX_MARK_AGE_BLOCKS must be rejected,
/// so a stalled keeper can't leave positions settling against a frozen price.
#[tokio::test]
async fn perp_stale_mark_rejected() {
    let (env, program) = deploy().await;
    setup_perps(&env, &program).await;

    let _: u64 = perps_svc(&program)
        .pending_call::<perp_io::OpenPosition>((Asset::BTC, true, 10_000u64, 2u32))
        .await
        .unwrap()
        .unwrap();

    // Advance well past the staleness window without republishing the mark.
    let bn = env.system().block_height();
    env.system().run_to_block(bn + 200);

    let stale: Result<Result<(u64, i64), ContractError>, GtestError> = perps_svc(&program)
        .pending_call::<perp_io::ClosePosition>((Asset::BTC,))
        .await;
    match stale {
        Ok(Err(ContractError::StaleMark)) => {}
        other => panic!("expected StaleMark, got {other:?}"),
    }

    // Republishing the mark makes it fresh again → close succeeds.
    let _: () = perps_svc(&program)
        .pending_call::<perp_io::SetMarkPrice>((Asset::BTC, BTC_MARK))
        .await
        .unwrap()
        .unwrap();
    let _: (u64, i64) = perps_svc(&program)
        .pending_call::<perp_io::ClosePosition>((Asset::BTC,))
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn perp_open_without_mark_fails() {
    let (env, program) = deploy().await;
    join_alice(&env, &program).await;

    let result: Result<Result<u64, ContractError>, GtestError> = perps_svc(&program)
        .pending_call::<perp_io::OpenPosition>((Asset::ETH, true, 10_000u64, 2u32))
        .await;
    match result {
        Ok(Err(ContractError::NoMarkPrice)) => {}
        other => panic!("expected NoMarkPrice, got {other:?}"),
    }
}

#[tokio::test]
async fn call_agent_service_to_nonexistent_fails() {
    let (env, program) = deploy().await;
    join_alice(&env, &program).await;

    let target = ActorId::from([0u8; 32]);
    let result: Result<Result<Vec<u8>, ContractError>, GtestError> = orderbook_svc(&program)
        .pending_call::<ob_io::CallAgentService>((target, vec![1, 2, 3], 100_000_000_000))
        .await;
    match result {
        Ok(Err(ContractError::AgentCallFailed)) => {}
        _ => panic!("expected AgentCallFailed, got {result:?}"),
    }
}

// ── v1 spot CLOB (real VFT escrow) ───────────────────────────────────────────────────

/// The DEX actor bound to a specific caller.
fn as_dex(
    env: &GtestEnv,
    dex: ActorId,
    who: u64,
) -> Actor<ThebookClientProgram, GtestEnv> {
    Actor::<ThebookClientProgram, GtestEnv>::new(env.clone().with_actor_id(who.into()), dex)
}

/// A token program actor bound to a specific caller.
fn as_tok(
    env: &GtestEnv,
    tid: ActorId,
    who: u64,
) -> Actor<ThebookTokenClientProgram, GtestEnv> {
    Actor::<ThebookTokenClientProgram, GtestEnv>::new(env.clone().with_actor_id(who.into()), tid)
}

async fn balance_of(env: &GtestEnv, token: ActorId, who: u64) -> U256 {
    as_tok(env, token, who)
        .vft()
        .pending_call::<tok_vft_io::BalanceOf>((who.into(),))
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

/// List an ETH/USD spot pair (both 6-decimal test tokens) as the admin. Returns
/// (base=eth, quote=usd, pair_id).
async fn list_eth_usd(
    program: &Actor<ThebookClientProgram, GtestEnv>,
) -> (ActorId, ActorId, u64) {
    let (t_usd, _t_btc, t_eth, _t_vara): (ActorId, ActorId, ActorId, ActorId) = program
        .orderbook()
        .pending_call::<ob_io::GetTokens>(())
        .await
        .unwrap();
    let pair_id: u64 = program
        .spot()
        .pending_call::<spot_io::ListPair>((t_eth, t_usd, 6u8, 6u8))
        .await
        .unwrap()
        .unwrap();
    (t_eth, t_usd, pair_id)
}

#[tokio::test]
async fn spot_only_admin_can_list() {
    let (env, program) = deploy().await;
    let (t_usd, _t_btc, t_eth, _t_vara): (ActorId, ActorId, ActorId, ActorId) = program
        .orderbook()
        .pending_call::<ob_io::GetTokens>(())
        .await
        .unwrap();
    // BOB is not the admin.
    let denied: Result<u64, _> = as_dex(&env, program.id(), BOB)
        .spot()
        .pending_call::<spot_io::ListPair>((t_eth, t_usd, 6u8, 6u8))
        .await
        .unwrap();
    assert!(denied.is_err(), "non-admin must not list a pair");
}

#[tokio::test]
async fn spot_limit_cross_and_withdraw() {
    let (env, program) = deploy().await;
    let dex = program.id();
    let (base, quote, pair_id) = list_eth_usd(&program).await;
    assert_eq!(pair_id, 0);

    // Seller BOB: has 1_000_000 base from the faucet, escrows 500_000 in a limit sell.
    claim_and_approve(&env, base, dex, BOB, 500_000).await;
    let sell_oid: u64 = as_dex(&env, dex, BOB)
        .spot()
        .pending_call::<spot_io::PlaceLimit>((pair_id, Side::Sell, 100u128, 500_000u128))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(sell_oid, 0);
    // Escrow left the seller's wallet: 1_000_000 - 500_000.
    assert_eq!(balance_of(&env, base, BOB).await, U256::from(500_000));

    // Buyer ALICE: escrow = notional(100, 500_000, 6) = 50 quote.
    claim_and_approve(&env, quote, dex, ALICE, 50).await;
    let buy_oid: u64 = program
        .spot()
        .pending_call::<spot_io::PlaceLimit>((pair_id, Side::Buy, 100u128, 500_000u128))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(buy_oid, 1);

    // Fills credited to claimable balances at the resting price.
    let alice_base: u128 = program
        .spot()
        .pending_call::<spot_io::GetClaim>((base,))
        .await
        .unwrap();
    let bob_quote: u128 = as_dex(&env, dex, BOB)
        .spot()
        .pending_call::<spot_io::GetClaim>((quote,))
        .await
        .unwrap();
    assert_eq!(alice_base, 500_000, "buyer receives the base");
    assert_eq!(bob_quote, 50, "seller receives the quote");

    // Withdraw pushes real tokens back to the wallets.
    let w1: u128 = program
        .spot()
        .pending_call::<spot_io::Withdraw>((base,))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(w1, 500_000);
    assert_eq!(balance_of(&env, base, ALICE).await, U256::from(500_000));

    let w2: u128 = as_dex(&env, dex, BOB)
        .spot()
        .pending_call::<spot_io::Withdraw>((quote,))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(w2, 50);
    assert_eq!(balance_of(&env, quote, BOB).await, U256::from(50));
}

#[tokio::test]
async fn spot_cancel_refunds_escrow() {
    let (env, program) = deploy().await;
    let dex = program.id();
    let (base, _quote, pair_id) = list_eth_usd(&program).await;

    // BOB rests a sell that nobody crosses; 300_000 base is escrowed, not claimable.
    claim_and_approve(&env, base, dex, BOB, 300_000).await;
    let oid: u64 = as_dex(&env, dex, BOB)
        .spot()
        .pending_call::<spot_io::PlaceLimit>((pair_id, Side::Sell, 200u128, 300_000u128))
        .await
        .unwrap()
        .unwrap();
    let before: u128 = as_dex(&env, dex, BOB)
        .spot()
        .pending_call::<spot_io::GetClaim>((base,))
        .await
        .unwrap();
    assert_eq!(before, 0, "escrow is not claimable while the order rests");

    // Cancel refunds the unfilled escrow to the claimable balance.
    let _: () = as_dex(&env, dex, BOB)
        .spot()
        .pending_call::<spot_io::CancelOrder>((oid,))
        .await
        .unwrap()
        .unwrap();
    let after: u128 = as_dex(&env, dex, BOB)
        .spot()
        .pending_call::<spot_io::GetClaim>((base,))
        .await
        .unwrap();
    assert_eq!(after, 300_000, "cancel refunds the full unfilled escrow");

    // And it can be withdrawn back to the wallet in full.
    let _: u128 = as_dex(&env, dex, BOB)
        .spot()
        .pending_call::<spot_io::Withdraw>((base,))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(balance_of(&env, base, BOB).await, U256::from(1_000_000));
}

#[tokio::test]
async fn spot_partial_fill_rests_remainder() {
    let (env, program) = deploy().await;
    let dex = program.id();
    let (base, quote, pair_id) = list_eth_usd(&program).await;

    // Seller rests 300_000 @ 100.
    claim_and_approve(&env, base, dex, BOB, 300_000).await;
    let _: u64 = as_dex(&env, dex, BOB)
        .spot()
        .pending_call::<spot_io::PlaceLimit>((pair_id, Side::Sell, 100u128, 300_000u128))
        .await
        .unwrap()
        .unwrap();

    // Buyer wants 500_000 @ 100: 300_000 fills, 200_000 rests as a bid.
    claim_and_approve(&env, quote, dex, ALICE, 50).await;
    let buy_oid: u64 = program
        .spot()
        .pending_call::<spot_io::PlaceLimit>((pair_id, Side::Buy, 100u128, 500_000u128))
        .await
        .unwrap()
        .unwrap();

    // Buyer got the 300_000 that filled; seller got its quote.
    let alice_base: u128 = program
        .spot()
        .pending_call::<spot_io::GetClaim>((base,))
        .await
        .unwrap();
    let bob_quote: u128 = as_dex(&env, dex, BOB)
        .spot()
        .pending_call::<spot_io::GetClaim>((quote,))
        .await
        .unwrap();
    assert_eq!(alice_base, 300_000);
    assert_eq!(bob_quote, 30); // notional(100, 300_000, 6)

    // A 200_000 bid rests at 100.
    let (bids, asks): (Vec<(u128, u128)>, Vec<(u128, u128)>) = program
        .spot()
        .pending_call::<spot_io::GetOrderbook>((pair_id,))
        .await
        .unwrap();
    assert_eq!(bids, vec![(100, 200_000)]);
    assert!(asks.is_empty());

    // Cancelling the remainder refunds its escrow: notional(100, 200_000, 6) = 20.
    let _: () = program
        .spot()
        .pending_call::<spot_io::CancelOrder>((buy_oid,))
        .await
        .unwrap()
        .unwrap();
    let alice_quote: u128 = program
        .spot()
        .pending_call::<spot_io::GetClaim>((quote,))
        .await
        .unwrap();
    assert_eq!(alice_quote, 20);
}

#[tokio::test]
async fn spot_multi_level_sweep_refunds_overpay() {
    let (env, program) = deploy().await;
    let dex = program.id();
    let (base, quote, pair_id) = list_eth_usd(&program).await;

    // Two asks: 100_000 @ 100 and 100_000 @ 120.
    claim_and_approve(&env, base, dex, BOB, 200_000).await;
    for price in [100u128, 120u128] {
        let _: u64 = as_dex(&env, dex, BOB)
            .spot()
            .pending_call::<spot_io::PlaceLimit>((pair_id, Side::Sell, price, 100_000u128))
            .await
            .unwrap()
            .unwrap();
    }

    // Buyer crosses both with a limit of 150; escrow = notional(150, 200_000, 6) = 30.
    claim_and_approve(&env, quote, dex, ALICE, 30).await;
    let _: u64 = program
        .spot()
        .pending_call::<spot_io::PlaceLimit>((pair_id, Side::Buy, 150u128, 200_000u128))
        .await
        .unwrap()
        .unwrap();

    // Buyer receives all 200_000 base; overpay refunded: (150-100)*0.1 + (150-120)*0.1 = 5 + 3.
    let alice_base: u128 = program
        .spot()
        .pending_call::<spot_io::GetClaim>((base,))
        .await
        .unwrap();
    let alice_quote: u128 = program
        .spot()
        .pending_call::<spot_io::GetClaim>((quote,))
        .await
        .unwrap();
    let bob_quote: u128 = as_dex(&env, dex, BOB)
        .spot()
        .pending_call::<spot_io::GetClaim>((quote,))
        .await
        .unwrap();
    assert_eq!(alice_base, 200_000);
    assert_eq!(alice_quote, 8, "overpay refund at each level");
    assert_eq!(bob_quote, 22, "seller paid at each resting price: 10 + 12");
}

#[tokio::test]
async fn spot_market_buy_refunds_unspent_budget() {
    let (env, program) = deploy().await;
    let dex = program.id();
    let (base, quote, pair_id) = list_eth_usd(&program).await;

    claim_and_approve(&env, base, dex, BOB, 100_000).await;
    let _: u64 = as_dex(&env, dex, BOB)
        .spot()
        .pending_call::<spot_io::PlaceLimit>((pair_id, Side::Sell, 100u128, 100_000u128))
        .await
        .unwrap()
        .unwrap();

    // Budget 1000, only 10 is spent (notional(100, 100_000, 6)); 990 refunded.
    claim_and_approve(&env, quote, dex, ALICE, 1000).await;
    let _: u64 = program
        .spot()
        .pending_call::<spot_io::MarketBuy>((pair_id, 100_000u128, 1000u128))
        .await
        .unwrap()
        .unwrap();

    let alice_base: u128 = program
        .spot()
        .pending_call::<spot_io::GetClaim>((base,))
        .await
        .unwrap();
    let alice_quote: u128 = program
        .spot()
        .pending_call::<spot_io::GetClaim>((quote,))
        .await
        .unwrap();
    let bob_quote: u128 = as_dex(&env, dex, BOB)
        .spot()
        .pending_call::<spot_io::GetClaim>((quote,))
        .await
        .unwrap();
    assert_eq!(alice_base, 100_000);
    assert_eq!(alice_quote, 990, "unspent budget refunded");
    assert_eq!(bob_quote, 10);
}

#[tokio::test]
async fn spot_market_sell_into_bids() {
    let (env, program) = deploy().await;
    let dex = program.id();
    let (base, quote, pair_id) = list_eth_usd(&program).await;

    // BOB rests a buy 100_000 @ 100; escrow quote = notional(100, 100_000, 6) = 10.
    claim_and_approve(&env, quote, dex, BOB, 10).await;
    let _: u64 = as_dex(&env, dex, BOB)
        .spot()
        .pending_call::<spot_io::PlaceLimit>((pair_id, Side::Buy, 100u128, 100_000u128))
        .await
        .unwrap()
        .unwrap();

    // ALICE market-sells 100_000 base into that bid.
    claim_and_approve(&env, base, dex, ALICE, 100_000).await;
    let _: u64 = program
        .spot()
        .pending_call::<spot_io::MarketSell>((pair_id, 100_000u128))
        .await
        .unwrap()
        .unwrap();

    let alice_quote: u128 = program
        .spot()
        .pending_call::<spot_io::GetClaim>((quote,))
        .await
        .unwrap();
    let bob_base: u128 = as_dex(&env, dex, BOB)
        .spot()
        .pending_call::<spot_io::GetClaim>((base,))
        .await
        .unwrap();
    assert_eq!(alice_quote, 10, "seller receives quote proceeds");
    assert_eq!(bob_base, 100_000, "resting buyer receives the base");
}

#[tokio::test]
async fn spot_delist_blocks_new_orders() {
    let (env, program) = deploy().await;
    let dex = program.id();
    let (base, _quote, pair_id) = list_eth_usd(&program).await;

    // Admin delists the pair.
    let _: () = program
        .spot()
        .pending_call::<spot_io::DelistPair>((pair_id,))
        .await
        .unwrap()
        .unwrap();

    // New orders are rejected on an inactive pair.
    claim_and_approve(&env, base, dex, BOB, 100_000).await;
    let res: Result<u64, _> = as_dex(&env, dex, BOB)
        .spot()
        .pending_call::<spot_io::PlaceLimit>((pair_id, Side::Sell, 100u128, 100_000u128))
        .await
        .unwrap();
    assert!(res.is_err(), "delisted pair must reject new orders");
}

#[tokio::test]
async fn spot_place_without_approval_reverts() {
    let (env, program) = deploy().await;
    let dex = program.id();
    let (base, _quote, pair_id) = list_eth_usd(&program).await;

    // BOB has base tokens (faucet) but never approves the DEX.
    let tok = as_tok(&env, base, BOB);
    let _: U256 = tok
        .faucet()
        .pending_call::<tok_faucet_io::Claim>(())
        .await
        .unwrap()
        .unwrap();

    let res: Result<u64, _> = as_dex(&env, dex, BOB)
        .spot()
        .pending_call::<spot_io::PlaceLimit>((pair_id, Side::Sell, 100u128, 100_000u128))
        .await
        .unwrap();
    assert!(res.is_err(), "placing without approval must fail on escrow");

    // No order was recorded and no tokens moved.
    let mine = as_dex(&env, dex, BOB)
        .spot()
        .pending_call::<spot_io::GetMyOrders>(())
        .await
        .unwrap();
    assert!(mine.is_empty(), "failed escrow must leave no resting order");
    assert_eq!(balance_of(&env, base, BOB).await, U256::from(1_000_000));
}

#[tokio::test]
async fn spot_market_buy_empty_book_refunds_all() {
    let (env, program) = deploy().await;
    let dex = program.id();
    let (_base, quote, pair_id) = list_eth_usd(&program).await;

    // No asks exist; the whole budget must come back as claimable quote.
    claim_and_approve(&env, quote, dex, ALICE, 500).await;
    let _: u64 = program
        .spot()
        .pending_call::<spot_io::MarketBuy>((pair_id, 100_000u128, 500u128))
        .await
        .unwrap()
        .unwrap();

    let alice_quote: u128 = program
        .spot()
        .pending_call::<spot_io::GetClaim>((quote,))
        .await
        .unwrap();
    assert_eq!(alice_quote, 500, "empty book refunds the full budget");
}

#[tokio::test]
async fn spot_unknown_pair_rejects() {
    let (env, program) = deploy().await;
    let dex = program.id();
    let _ = list_eth_usd(&program).await;

    let res: Result<u64, _> = as_dex(&env, dex, BOB)
        .spot()
        .pending_call::<spot_io::PlaceLimit>((999u64, Side::Buy, 100u128, 100u128))
        .await
        .unwrap();
    assert!(res.is_err(), "unknown pair id must be rejected");
}
