#![no_std]

//! Mintable VFT test token for thebookdex's testnet launch. Composed from the
//! official Gear `awesome-sails` building blocks — we deploy one instance per
//! traded asset (wUSDC / wBTC / wETH / wVARA) and let users claim them, rather
//! than minting fake balances inside the DEX.
//!
//! Services exposed:
//! - `vft`          — transfer / approve / balance_of (ERC-20-style core)
//! - `vft_admin`    — role-gated mint / burn (deployer is the initial admin)
//! - `vft_metadata` — name / symbol / decimals

use awesome_sails::{
    access_control::{AccessControl, RolesStorage},
    vft,
    vft::utils::{Allowances, Balances},
    vft_admin,
    vft_metadata::{self, Metadata},
};
use awesome_sails_storage::StorageRefCell;
use awesome_sails_utils::pause::{PausableRef, Pause};
use core::cell::RefCell;
use sails_rs::prelude::*;

pub struct Program {
    access_control_roles: RefCell<RolesStorage>,
    allowances: RefCell<Allowances>,
    balances: RefCell<Balances>,
    metadata: Metadata,
    pause: Pause,
}

impl Program {
    fn allowances(&self) -> PausableRef<'_, Allowances> {
        PausableRef::new(&self.pause, StorageRefCell::new(&self.allowances))
    }

    fn balances(&self) -> PausableRef<'_, Balances> {
        PausableRef::new(&self.pause, StorageRefCell::new(&self.balances))
    }

    fn access_control_storage(&self) -> StorageRefCell<'_, RolesStorage> {
        StorageRefCell::new(&self.access_control_roles)
    }
}

#[program]
impl Program {
    /// Deploy a token with the given metadata. The deployer becomes the initial
    /// access-control admin, i.e. the account allowed to grant minter roles / mint.
    pub fn new(name: String, symbol: String, decimals: u8) -> Self {
        let mut access_control_roles = RolesStorage::default();
        let deployer = Syscall::message_source();
        access_control_roles.grant_initial_admin(deployer);

        Self {
            access_control_roles: RefCell::new(access_control_roles),
            allowances: Default::default(),
            balances: Default::default(),
            metadata: Metadata::new(name, symbol, decimals),
            pause: Pause::default(),
        }
    }

    pub fn vft(&self) -> vft::Vft<'_> {
        vft::Vft::new(self.allowances(), self.balances())
    }

    pub fn vft_admin(
        &self,
    ) -> vft_admin::VftAdmin<
        '_,
        StorageRefCell<'_, RolesStorage>,
        PausableRef<'_, Allowances>,
        PausableRef<'_, Balances>,
    > {
        vft_admin::VftAdmin::new(
            self.access_control(),
            self.allowances(),
            self.balances(),
            &self.pause,
            self.vft(),
        )
    }

    pub fn vft_metadata(&self) -> vft_metadata::VftMetadata<&Metadata> {
        vft_metadata::VftMetadata::new(&self.metadata)
    }

    pub fn access_control(&self) -> AccessControl<'_, StorageRefCell<'_, RolesStorage>> {
        AccessControl::new(self.access_control_storage())
    }
}
