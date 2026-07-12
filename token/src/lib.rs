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
//! - `faucet`       — public one-per-account `claim` of a deploy-time amount

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
use sails_rs::{collections::BTreeMap, prelude::*};

/// Concrete `VftAdmin` type for this program (four generics fixed to our storages).
type Admin<'a> = vft_admin::VftAdmin<
    'a,
    StorageRefCell<'a, RolesStorage>,
    PausableRef<'a, Allowances>,
    PausableRef<'a, Balances>,
>;

#[derive(Encode, Decode, TypeInfo, Clone, Copy, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum FaucetError {
    /// This account has already claimed from the faucet.
    AlreadyClaimed,
    /// The underlying mint failed (paused, overflow, …).
    MintFailed,
}

/// Public, unauthenticated test-token faucet. Each account may `claim` once,
/// receiving `faucet_amount` freshly minted tokens. Replaces the DEX's old free-
/// money-on-join: value now comes from real, transferable, withdrawable VFT
/// balances. Holds `&Program` so `claim` can build the admin exposure (whose
/// `do_mint` bypasses MINTER_ROLE) at call time.
pub struct Faucet<'a> {
    program: &'a Program,
}

#[service]
impl Faucet<'_> {
    /// Mint `faucet_amount` tokens to the caller. Errors if they have claimed before.
    #[export]
    pub fn claim(&mut self) -> Result<U256, FaucetError> {
        let caller = Syscall::message_source();
        if self.program.claimed.borrow().contains_key(&caller) {
            return Err(FaucetError::AlreadyClaimed);
        }
        // `do_mint` bypasses MINTER_ROLE; the once-per-account guard above is the
        // faucet's own rate limit. Mint first, then record — if the mint traps the
        // whole message reverts and the guard is not written.
        let mut admin = self.program.vft_admin();
        let amount = self.program.faucet_amount;
        unsafe {
            admin
                .do_mint(caller, amount)
                .map_err(|_| FaucetError::MintFailed)?;
        }
        self.program.claimed.borrow_mut().insert(caller, ());
        Ok(amount)
    }

    /// Whether `who` has already claimed.
    #[export]
    pub fn has_claimed(&self, who: ActorId) -> bool {
        self.program.claimed.borrow().contains_key(&who)
    }
}

pub struct Program {
    access_control_roles: RefCell<RolesStorage>,
    allowances: RefCell<Allowances>,
    balances: RefCell<Balances>,
    metadata: Metadata,
    pause: Pause,
    faucet_amount: U256,
    claimed: RefCell<BTreeMap<ActorId, ()>>,
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
    /// Deploy a token with the given metadata and per-account faucet amount. The
    /// deployer becomes the initial access-control admin (can grant minter roles).
    pub fn new(name: String, symbol: String, decimals: u8, faucet_amount: U256) -> Self {
        let mut access_control_roles = RolesStorage::default();
        let deployer = Syscall::message_source();
        access_control_roles.grant_initial_admin(deployer);

        Self {
            access_control_roles: RefCell::new(access_control_roles),
            allowances: Default::default(),
            balances: Default::default(),
            metadata: Metadata::new(name, symbol, decimals),
            pause: Pause::default(),
            faucet_amount,
            claimed: RefCell::new(BTreeMap::new()),
        }
    }

    pub fn vft(&self) -> vft::Vft<'_> {
        vft::Vft::new(self.allowances(), self.balances())
    }

    pub fn vft_admin(&self) -> Admin<'_> {
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

    pub fn faucet(&self) -> Faucet<'_> {
        Faucet { program: self }
    }
}
