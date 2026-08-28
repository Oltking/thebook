#![no_std]
// Query methods return tuples of primitives (bids/asks levels, order rows) that map
// cleanly onto the Sails IDL. `#[export]` regenerates each fn, so a per-fn allow is
// dropped — suppress the tuple-shape lint crate-wide instead.
#![allow(clippy::type_complexity)]

//! thebook — a non-custodial spot CLOB and cash-settled perps venue on Vara.
//!
//! The program exposes exactly two services, both over a single `SpotState`:
//! `Spot` (the order book, escrow, and claimable balances) and `PerpsV1`.
//!
//! The legacy virtual-balance services (`orderbook`, `amm`, `perps`) and their
//! `DexState` were removed in the audit remediation. They shared this program's
//! account — and therefore its real token balance — while running a ledger anyone
//! could mint into via `Join`, which `Withdraw` then paid out in real tokens
//! (finding C-02). That module also carried `call_agent_service`, an
//! unauthenticated arbitrary cross-program call that let any caller spend the
//! program's own token balance (finding C-01). Neither has a safe version, so
//! neither came back.

use sails_rs::cell::RefCell;
use sails_rs::gstd::msg;
use sails_rs::prelude::*;

pub mod perps_spot;
pub mod spot;
pub mod types;

pub use perps_spot::PerpsService as SpotPerpsService;
pub use spot::{SpotService, SpotState};

pub struct Program {
    /// v1 spot CLOB + perps state (real VFT escrow, claimable balances).
    spot: RefCell<SpotState>,
}

#[sails_rs::program]
impl Program {
    // Sails constructor (route "New"); a `Default` impl would be meaningless here.
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        // The deployer becomes the initial admin / listing authority. On mainnet,
        // admin is transferred to the multisig via the two-step handover.
        let spot = SpotState {
            admin: msg::source(),
            ..SpotState::default()
        };
        Self {
            spot: RefCell::new(spot),
        }
    }

    pub fn spot(&self) -> SpotService<'_> {
        SpotService::new(&self.spot)
    }

    // Perps share the spot state so margin/PnL settle through the same claimable
    // balances (withdraw via Spot/Withdraw).
    pub fn perps_v1(&self) -> SpotPerpsService<'_> {
        SpotPerpsService::new(&self.spot)
    }
}
