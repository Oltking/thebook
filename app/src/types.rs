//! Shared primitives for the v1 spot CLOB and perps services.
//!
//! The legacy virtual-balance types (agents, pools, virtual orders, the `Asset`/
//! `TokenKind` enums) were removed with the services that used them — see audit
//! finding C-02. Nothing here mints or tracks a balance; the only state that
//! represents value lives in `SpotState`, backed 1:1 by real tokens.

use sails_rs::prelude::*;

extern crate alloc;
use alloc::string::String;

/// Wrapper that bypasses SCALE Vec<u8> encoding — sends payload bytes as-is.
/// Sails dispatch uses `load_bytes()` (raw bytes), so we must NOT wrap in SCALE.
pub struct RawPayload(pub Vec<u8>);

impl Encode for RawPayload {
    fn encode(&self) -> Vec<u8> {
        self.0.clone()
    }
    fn size_hint(&self) -> usize {
        self.0.len()
    }
}

/// Decodes a Sails reply that echoes the route before the return value.
/// Sails reply format: SCALE_string(service_name) + SCALE_string(func_name) + SCALE(return_value)
pub struct SailsReply<T: Decode>(pub T);

impl<T: Decode> Decode for SailsReply<T> {
    fn decode<I: sails_rs::scale_codec::Input>(
        input: &mut I,
    ) -> Result<Self, sails_rs::scale_codec::Error> {
        let _ = String::decode(input)?;
        let _ = String::decode(input)?;
        let inner = T::decode(input)?;
        Ok(SailsReply(inner))
    }
}

/// `Ord` matters: `Side` is part of the spot price-level index key
/// `(pair_id, side, price)`, which is what makes matching walk levels instead of
/// every order ever placed.
#[derive(Encode, Decode, TypeInfo, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum Side {
    Buy,
    Sell,
}
