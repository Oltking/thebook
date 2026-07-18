#![no_std]

//! Reference on-chain trading agent for thebookdex.
//!
//! This is a *program* (an actor) that trades on thebook the way Vara A2A
//! intends: on init it sends a `Join` message to the DEX from its own identity,
//! and its `act()` entrypoint — poked by a keeper on a cadence — reads a market
//! from thebook via a cross-program query and sends a trade back. The owner
//! (deployer) controls it; nobody else can make it act.
//!
//! Its wire types (Asset/Side/AgentStrategy) mirror thebook's exactly, so the
//! SCALE encoding of every cross-program call is byte-identical to what the DEX
//! expects.

use sails_rs::cell::RefCell;
use sails_rs::gstd::{exec, msg};
use sails_rs::prelude::*;

// ── Wire types, mirrored from thebook exactly ──
// Defined locally (rather than depending on `thebook-app`) so the agent's WASM
// LTO build stays clean. Variant order MUST match the DEX so SCALE encoding of
// every cross-program call is byte-identical.

#[derive(Encode, Decode, TypeInfo, Clone, Copy, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum Asset {
    BTC,
    ETH,
    VARA,
}

#[derive(Encode, Decode, TypeInfo, Clone, Copy, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum Side {
    Buy,
    Sell,
}

#[derive(Encode, Decode, TypeInfo, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum AgentStrategy {
    #[default]
    ArbitrageHunter,
    MarketMaker,
    Momentum,
}

/// Sends payload bytes as-is (sails dispatch reads raw bytes; no SCALE Vec wrap).
struct RawPayload(Vec<u8>);
impl Encode for RawPayload {
    fn encode(&self) -> Vec<u8> {
        self.0.clone()
    }
    fn size_hint(&self) -> usize {
        self.0.len()
    }
}

/// Decodes a sails reply that echoes `service_name`, `func_name`, then the value.
struct SailsReply<T: Decode>(T);
impl<T: Decode> Decode for SailsReply<T> {
    fn decode<I: sails_rs::scale_codec::Input>(
        input: &mut I,
    ) -> Result<Self, sails_rs::scale_codec::Error> {
        let _ = String::decode(input)?;
        let _ = String::decode(input)?;
        Ok(SailsReply(T::decode(input)?))
    }
}

/// Compiled WASM of this program, for host-side deploy tooling.
#[cfg(not(target_arch = "wasm32"))]
pub use code::WASM_BINARY_OPT as WASM_BINARY;
#[cfg(not(target_arch = "wasm32"))]
mod code {
    include!(concat!(env!("OUT_DIR"), "/wasm_binary.rs"));
}

/// One resting-order tick on thebook equals $1000 (matches the DEX price grid).
const TICK_USD: u64 = 1000;
/// Trade size in asset base units (1e5 scale) — 0.001 BTC-equivalent. Small on
/// purpose: a reference agent should nibble, not swing.
const TRADE_QTY: u64 = 100;

struct AgentState {
    owner: ActorId,
    keeper: ActorId,
    thebook: ActorId,
    name: String,
    strategy: AgentStrategy,
    active: bool,
    actions: u32,
    last_block: u32,
    last_note: String,
}

/// Build the SCALE route payload for a call to thebook's `Orderbook` service.
fn ob_route(method: &str, args: Vec<u8>) -> Vec<u8> {
    let mut payload = "Orderbook".encode();
    payload.extend(method.encode());
    payload.extend(args);
    payload
}

pub struct Program {
    state: RefCell<AgentState>,
}

#[sails_rs::program]
impl Program {
    /// Deploy + register. The deployer becomes owner and initial keeper. We fire
    /// a `Join` at thebook (fire-and-forget: registration doesn't need the reply)
    /// so the agent has an identity on the DEX from birth.
    #[allow(clippy::new_without_default)]
    pub fn new(thebook: ActorId, name: String, strategy: AgentStrategy) -> Self {
        let owner = msg::source();
        let payload = ob_route("Join", (name.clone(), strategy).encode());
        // Best-effort A2A registration; ignore send errors so init never traps.
        let _ = msg::send(thebook, RawPayload(payload), 0);
        Self {
            state: RefCell::new(AgentState {
                owner,
                keeper: owner,
                thebook,
                name,
                strategy,
                active: true,
                actions: 0,
                last_block: 0,
                last_note: String::new(),
            }),
        }
    }

    pub fn agent(&self) -> AgentService<'_> {
        AgentService::new(&self.state)
    }
}

pub struct AgentService<'a> {
    state: &'a RefCell<AgentState>,
}

impl<'a> AgentService<'a> {
    pub fn new(state: &'a RefCell<AgentState>) -> Self {
        Self { state }
    }
}

#[sails_rs::service]
impl<'a> AgentService<'a> {
    /// Poked by the keeper (or owner) to take one step: read thebook's BTC book,
    /// pick an action per the agent's strategy, and send it back to thebook.
    /// Returns a short human-readable note describing what it did.
    #[export]
    pub async fn act(&mut self) -> String {
        let (owner, keeper, thebook, strategy, active) = {
            let s = self.state.borrow();
            (s.owner, s.keeper, s.thebook, s.strategy, s.active)
        };
        let caller = msg::source();
        if caller != owner && caller != keeper {
            return "unauthorized".into();
        }
        if !active {
            return "paused".into();
        }

        // Read the BTC book from thebook (A2A query → reply).
        let gas = exec::gas_available() / 3;
        let read = ob_route("GetOrderbook", (Asset::BTC).encode());
        let book = msg::send_for_reply_as::<
            RawPayload,
            SailsReply<(Vec<(u64, u64)>, Vec<(u64, u64)>)>,
        >(thebook, RawPayload(read), gas as u128, 0);
        let (bids, asks) = match book {
            Ok(fut) => match fut.await {
                Ok(reply) => reply.0,
                Err(_) => return self.note("could not read the book"),
            },
            Err(_) => return self.note("could not reach thebook"),
        };

        let best_bid = bids.first().map(|(p, _)| *p).unwrap_or(0);
        let best_ask = asks.first().map(|(p, _)| *p).unwrap_or(0);

        // Decide per strategy, then fire the trade (fire-and-forget: fills are
        // observable on thebook; the agent just records intent).
        let note = match strategy {
            // Take liquidity when the book offers it.
            AgentStrategy::Momentum | AgentStrategy::ArbitrageHunter => {
                if best_ask > 0 {
                    let pay = ob_route("MarketBuy", (Asset::BTC, TRADE_QTY).encode());
                    let _ = msg::send(thebook, RawPayload(pay), 0);
                    "market-bought BTC into the offer"
                } else {
                    "no asks to take — held"
                }
            }
            // Provide liquidity: rest a bid just under the best bid (or a floor).
            AgentStrategy::MarketMaker => {
                let tick = if best_bid > 1 { best_bid - 1 } else { 1 };
                let _ = best_ask; // (a fuller MM would also post an ask)
                let pay = ob_route(
                    "PlaceLimit",
                    (Side::Buy, Asset::BTC, tick, TRADE_QTY).encode(),
                );
                let _ = msg::send(thebook, RawPayload(pay), 0);
                "posted a bid to earn the spread"
            }
        };

        self.note(note)
    }

    /// Owner-only: pause/resume autonomous trading.
    #[export]
    pub fn set_active(&mut self, active: bool) -> bool {
        let mut s = self.state.borrow_mut();
        if msg::source() != s.owner {
            return false;
        }
        s.active = active;
        true
    }

    /// Owner-only: authorize a keeper address to poke `act()`.
    #[export]
    pub fn set_keeper(&mut self, keeper: ActorId) -> bool {
        let mut s = self.state.borrow_mut();
        if msg::source() != s.owner {
            return false;
        }
        s.keeper = keeper;
        true
    }

    /// Public view: (name, strategy, active, actions, last_block, last_note).
    #[export]
    pub fn info(&self) -> (String, AgentStrategy, bool, u32, u32, String) {
        let s = self.state.borrow();
        (
            s.name.clone(),
            s.strategy,
            s.active,
            s.actions,
            s.last_block,
            s.last_note.clone(),
        )
    }
}

impl<'a> AgentService<'a> {
    /// Record the outcome of an `act()` step and return it.
    fn note(&self, text: &str) -> String {
        let mut s = self.state.borrow_mut();
        s.actions = s.actions.saturating_add(1);
        s.last_block = exec::block_height();
        s.last_note = text.into();
        // Silence unused constant warnings in configurations that don't hit them.
        let _ = TICK_USD;
        text.into()
    }
}
