#![no_std]
// Query methods return tuples of primitives (bids/asks levels, order rows) that map
// cleanly onto the Sails IDL. `#[export]` regenerates each fn, so a per-fn allow is
// dropped — suppress the tuple-shape lint crate-wide instead.
#![allow(clippy::type_complexity)]

use sails_rs::cell::RefCell;
use sails_rs::gstd::msg;
use sails_rs::prelude::*;

pub mod amm;
pub mod orderbook;
pub mod perps;
pub mod perps_spot;
pub mod spot;
pub mod state;
pub mod types;

pub use amm::AmmService;
pub use orderbook::OrderbookService;
pub use perps::PerpsService;
pub use perps_spot::PerpsService as SpotPerpsService;
pub use spot::{SpotService, SpotState};
pub use state::DexState;

pub struct Program {
    state: RefCell<DexState>,
    /// v1 mainnet spot CLOB state (real VFT escrow). Separate from the legacy
    /// virtual-balance `state` so the two paths never entangle during the rewrite.
    spot: RefCell<SpotState>,
}

#[sails_rs::program]
impl Program {
    // Sails constructor (route "New"); a `Default` impl would be meaningless here.
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        // The deployer becomes admin for autopilot management (legacy) and the initial
        // spot listing authority. On mainnet, admin is transferred to the multisig.
        let deployer = msg::source();
        let state = DexState {
            admin: deployer,
            ..DexState::default()
        };
        let spot = SpotState {
            admin: deployer,
            ..SpotState::default()
        };
        Self {
            state: RefCell::new(state),
            spot: RefCell::new(spot),
        }
    }

    pub fn orderbook(&self) -> OrderbookService<'_> {
        OrderbookService::new(&self.state)
    }

    pub fn amm(&self) -> AmmService<'_> {
        AmmService::new(&self.state)
    }

    pub fn perps(&self) -> PerpsService<'_> {
        PerpsService::new(&self.state)
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
