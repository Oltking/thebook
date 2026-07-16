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
pub mod state;
pub mod types;

pub use amm::AmmService;
pub use orderbook::OrderbookService;
pub use perps::PerpsService;
pub use state::DexState;

pub struct Program {
    state: RefCell<DexState>,
}

#[sails_rs::program]
impl Program {
    // Sails constructor (route "New"); a `Default` impl would be meaningless here.
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        // The deployer becomes admin for autopilot management.
        let state = DexState {
            admin: msg::source(),
            ..DexState::default()
        };
        Self {
            state: RefCell::new(state),
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
}
