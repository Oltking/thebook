use sails_rs::ActorId;
use sails_rs::U256;
use sails_rs::client::*;
use sails_rs::gtest::*;

use thebook::WASM_BINARY;
use thebook_client::amm::io as amm_io;
use thebook_client::orderbook::io as ob_io;
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

async fn join_alice(env: &GtestEnv, program: &Actor<ThebookClientProgram, GtestEnv>) {
    let _: (u64, u64, u64, u64) = orderbook_svc(program)
        .pending_call::<ob_io::Join>(("Alice".to_string(), AgentStrategy::ArbitrageHunter))
        .await
        .unwrap();
    fund(env, program, ALICE).await;
}

async fn join_bob(env: &GtestEnv, program: &Actor<ThebookClientProgram, GtestEnv>) {
    let _: (u64, u64, u64, u64) = orderbook_svc(program)
        .pending_call::<ob_io::Join>(("Bob".to_string(), AgentStrategy::MarketMaker))
        .await
        .unwrap();
    fund(env, program, BOB).await;
}

// ── Orderbook tests ──

#[tokio::test]
async fn join_creates_agent() {
    let (env, program) = deploy().await;
    join_alice(&env, &program).await;

    let port: (u64, u64, u64, u64) = orderbook_svc(&program)
        .pending_call::<ob_io::GetPortfolio>(())
        .await
        .unwrap();
    assert_eq!(port, (100_000, 100_000, 1_000_000, 1_000_000_000));
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
        .pending_call::<ob_io::PlaceLimit>((Side::Buy, Asset::BTC, 50, 1))
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
    assert_eq!(port.0, 100_000);
}

#[tokio::test]
async fn place_limit_sell_then_cancel() {
    let (env, program) = deploy().await;
    join_alice(&env, &program).await;

    let oid: u64 = orderbook_svc(&program)
        .pending_call::<ob_io::PlaceLimit>((Side::Sell, Asset::BTC, 60, 1))
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

#[tokio::test]
async fn market_buy_fills_sell_order() {
    let (env, program) = deploy().await;
    join_alice(&env, &program).await;

    let _: u64 = orderbook_svc(&program)
        .pending_call::<ob_io::PlaceLimit>((Side::Sell, Asset::BTC, 50, 2))
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
        .pending_call::<ob_io::PlaceLimit>((Side::Buy, Asset::BTC, 50, 2))
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
        .pending_call::<ob_io::PlaceLimit>((Side::Buy, Asset::BTC, 50, 2))
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
    assert_eq!(port.0, 99_900, "resting buyer USD double-charged");
    assert_eq!(port.1, 100_001, "resting buyer did not receive bought BTC");
}

// Regression: same invariant for the incoming-limit-sell match path (place_limit,
// Side::Sell) rather than the market_sell path.
#[tokio::test]
async fn resting_buy_not_double_charged_on_limit_sell() {
    let (env, program) = deploy().await;
    join_alice(&env, &program).await;

    let _: u64 = orderbook_svc(&program)
        .pending_call::<ob_io::PlaceLimit>((Side::Buy, Asset::BTC, 50, 2))
        .await
        .unwrap()
        .unwrap();

    let bob = Actor::new(env.clone().with_actor_id(BOB.into()), program.id());
    join_bob(&env, &bob).await;
    let _: u64 = orderbook_svc(&bob)
        .pending_call::<ob_io::PlaceLimit>((Side::Sell, Asset::BTC, 50, 1))
        .await
        .unwrap()
        .unwrap();

    let port: (u64, u64, u64, u64) = orderbook_svc(&program)
        .pending_call::<ob_io::GetPortfolio>(())
        .await
        .unwrap();
    assert_eq!(port.0, 99_900, "resting buyer USD double-charged");
    assert_eq!(port.1, 100_001, "resting buyer did not receive bought BTC");
}

// Regression: signal_collab must NOT create a zero-balance agent for the partner,
// which would make their later join() return early and never fund them.
#[tokio::test]
async fn signal_collab_does_not_lock_out_join() {
    let (env, program) = deploy().await;
    join_alice(&env, &program).await;

    let bob_id: ActorId = BOB.into();
    let _: () = orderbook_svc(&program)
        .pending_call::<ob_io::SignalCollab>((bob_id, "gm".to_string()))
        .await
        .unwrap();

    let bob = Actor::new(env.clone().with_actor_id(BOB.into()), program.id());
    let bal: (u64, u64, u64, u64) = orderbook_svc(&bob)
        .pending_call::<ob_io::Join>(("Bob".to_string(), AgentStrategy::MarketMaker))
        .await
        .unwrap();
    // Join now creates a zero-balance identity (value comes from faucet+deposit).
    // The regression is that signal_collab must not pre-insert an agent for Bob,
    // which would make this join a no-op and lock him out — so identity must stick.
    assert_eq!(bal, (0, 0, 0, 0), "unexpected starting balances");
    let id: Option<(String, AgentStrategy)> = orderbook_svc(&bob)
        .pending_call::<ob_io::GetIdentity>(())
        .await
        .unwrap();
    assert_eq!(
        id,
        Some(("Bob".to_string(), AgentStrategy::MarketMaker)),
        "signal_collab locked Bob out of joining"
    );
}

// Regression: challenge must not silently destroy the caller's USD.
#[tokio::test]
async fn challenge_does_not_burn_funds() {
    let (env, program) = deploy().await;
    join_alice(&env, &program).await;
    let bob = Actor::new(env.clone().with_actor_id(BOB.into()), program.id());
    join_bob(&env, &bob).await;

    let bob_id: ActorId = BOB.into();
    let _: u32 = orderbook_svc(&program)
        .pending_call::<ob_io::Challenge>((bob_id, 500u64))
        .await
        .unwrap()
        .unwrap();

    let port: (u64, u64, u64, u64) = orderbook_svc(&program)
        .pending_call::<ob_io::GetPortfolio>(())
        .await
        .unwrap();
    assert_eq!(port.0, 100_000, "challenge burned caller USD");
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
        .pending_call::<ob_io::PlaceLimit>((Side::Sell, Asset::BTC, 50, 1))
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

    // Alice offers 1 BTC at a price Bob cannot cover (Bob starts with 100_000 USD).
    let _: u64 = orderbook_svc(&program)
        .pending_call::<ob_io::PlaceLimit>((Side::Sell, Asset::BTC, 200_000, 1))
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
    join_alice(&env, &program).await;

    // Alice is funded to the canonical portfolio via the real flow in join_alice.
    let port: (u64, u64, u64, u64) = orderbook_svc(&program)
        .pending_call::<ob_io::GetPortfolio>(())
        .await
        .unwrap();
    assert_eq!(port, (100_000, 100_000, 1_000_000, 1_000_000_000));

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
