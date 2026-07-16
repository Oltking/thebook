use crate::state::DexState;
use crate::types::*;
use sails_rs::cell::RefCell;
use sails_rs::gstd::{exec, msg};
use sails_rs::prelude::*;
use sails_rs::scale_codec::{Decode, Encode};

extern crate alloc;
use alloc::vec::Vec;

#[sails_rs::event]
#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum OrderbookEvent {
    OrderPlaced(OrderPlacedEvent),
    OrderCancelled(OrderCancelledEvent),
    Trade(TradeEvent),
}

fn balance_of(ag: &Agent, asset: Asset) -> u64 {
    match asset {
        Asset::BTC => ag.btc,
        Asset::ETH => ag.eth,
        Asset::VARA => ag.vara,
    }
}

fn add_asset(ag: &mut Agent, asset: Asset, qty: u64) {
    match asset {
        Asset::BTC => ag.btc += qty,
        Asset::ETH => ag.eth += qty,
        Asset::VARA => ag.vara += qty,
    }
}

fn sub_asset(ag: &mut Agent, asset: Asset, qty: u64) {
    match asset {
        Asset::BTC => ag.btc -= qty,
        Asset::ETH => ag.eth -= qty,
        Asset::VARA => ag.vara -= qty,
    }
}

fn kind_balance(ag: &Agent, kind: TokenKind) -> u64 {
    match kind {
        TokenKind::Usd => ag.usd,
        TokenKind::Btc => ag.btc,
        TokenKind::Eth => ag.eth,
        TokenKind::Vara => ag.vara,
    }
}

fn credit_kind(ag: &mut Agent, kind: TokenKind, amount: u64) {
    match kind {
        TokenKind::Usd => ag.usd += amount,
        TokenKind::Btc => ag.btc += amount,
        TokenKind::Eth => ag.eth += amount,
        TokenKind::Vara => ag.vara += amount,
    }
}

fn debit_kind(ag: &mut Agent, kind: TokenKind, amount: u64) {
    match kind {
        TokenKind::Usd => ag.usd -= amount,
        TokenKind::Btc => ag.btc -= amount,
        TokenKind::Eth => ag.eth -= amount,
        TokenKind::Vara => ag.vara -= amount,
    }
}

/// Drop the oldest trades so retained history never exceeds `MAX_TRADES`.
fn trim_trades(st: &mut DexState) {
    if st.trades.len() > MAX_TRADES {
        let excess = st.trades.len() - MAX_TRADES;
        st.trades.drain(0..excess);
    }
}

/// Build the SCALE route payload for a `Vft` service method call.
fn vft_route(method: &str, args: Vec<u8>) -> Vec<u8> {
    let mut payload = "Vft".encode();
    payload.extend(method.encode());
    payload.extend(args);
    payload
}

pub struct OrderbookService<'a> {
    state: &'a RefCell<DexState>,
}

impl<'a> OrderbookService<'a> {
    pub fn new(state: &'a RefCell<DexState>) -> Self {
        Self { state }
    }
}

#[sails_rs::service(events = OrderbookEvent)]
impl<'a> OrderbookService<'a> {
    /// Register the caller's agent identity (name + strategy). Creates the account
    /// with ZERO balances — real value comes from claiming test tokens at the faucet
    /// and `deposit`ing them, not from free money on join. Idempotent: re-joining
    /// returns the existing balances and keeps the original identity.
    #[export]
    pub fn join(&mut self, name: String, strategy: AgentStrategy) -> (u64, u64, u64, u64) {
        let caller = msg::source();
        let mut st = self.state.borrow_mut();
        if let Some(ag) = st.agents.get(&caller) {
            return (ag.usd, ag.btc, ag.eth, ag.vara);
        }
        let mut name = name;
        if name.len() > MAX_NAME_LEN {
            // Step back to a char boundary so truncation never panics on multibyte input.
            let mut end = MAX_NAME_LEN;
            while end > 0 && !name.is_char_boundary(end) {
                end -= 1;
            }
            name.truncate(end);
        }
        st.agents.insert(
            caller,
            Agent {
                id: caller,
                name,
                strategy,
                usd: 0,
                btc: 0,
                eth: 0,
                vara: 0,
            },
        );
        (0, 0, 0, 0)
    }

    /// Caller's agent identity, or None if they haven't joined. Used by the UI to
    /// decide whether to show the "Create your Agent" onboarding.
    #[export]
    pub fn get_identity(&self) -> Option<(String, AgentStrategy)> {
        let caller = msg::source();
        let st = self.state.borrow();
        st.agents
            .get(&caller)
            .map(|ag| (ag.name.clone(), ag.strategy))
    }

    #[export]
    pub fn place_limit(
        &mut self,
        side: Side,
        asset: Asset,
        price: u64,
        qty: u64,
    ) -> Result<u64, ContractError> {
        if price == 0 || qty == 0 {
            return Err(ContractError::BadParams);
        }
        let caller = msg::source();
        let mut st = self.state.borrow_mut();
        // Reject before any escrow/matching so a full book never mutates state.
        if st.orders.len() >= MAX_OPEN_ORDERS {
            return Err(ContractError::BookFull);
        }
        let ag = st
            .agents
            .get(&caller)
            .cloned()
            .ok_or(ContractError::JoinFirst)?;

        if side == Side::Buy {
            let cost = price * qty;
            if ag.usd < cost {
                return Err(ContractError::InsufficientUsd);
            }
            st.agents.get_mut(&caller).unwrap().usd -= cost;
        } else {
            if balance_of(&ag, asset) < qty {
                return Err(ContractError::InsufficientAsset);
            }
            sub_asset(st.agents.get_mut(&caller).unwrap(), asset, qty);
        }

        let oid = st.next_oid;
        st.next_oid += 1;
        let mut rem = qty;

        let match_indices: Vec<usize> = st
            .orders
            .iter()
            .enumerate()
            .filter(|(_, o)| {
                o.asset == asset
                    && o.side != side
                    && o.status != OrderStatus::Filled
                    && o.status != OrderStatus::Cancelled
                    && o.filled < o.qty
            })
            .filter(|(_, o)| {
                if side == Side::Buy {
                    o.price <= price
                } else {
                    o.price >= price
                }
            })
            .map(|(i, _)| i)
            .collect();

        for &mi in &match_indices {
            if rem == 0 {
                break;
            }
            let o = &st.orders[mi];
            let fill = rem.min(o.qty - o.filled);
            if fill == 0 {
                continue;
            }
            let buyer = if side == Side::Buy { caller } else { o.trader };
            let seller = if side == Side::Sell { caller } else { o.trader };
            let price_match = o.price;

            if side == Side::Buy {
                if let Some(ag) = st.agents.get_mut(&seller) {
                    ag.usd += price_match * fill;
                }
                if let Some(ag) = st.agents.get_mut(&buyer) {
                    add_asset(ag, asset, fill);
                    ag.usd += (price - price_match) * fill;
                }
            } else {
                // The resting buyer already escrowed `o.price` per unit when they
                // placed the limit buy, so only credit the asset here — deducting
                // USD again would double-charge them.
                if let Some(ag) = st.agents.get_mut(&buyer) {
                    add_asset(ag, asset, fill);
                }
                if let Some(ag) = st.agents.get_mut(&seller) {
                    ag.usd += price_match * fill;
                }
            }

            let tid = st.next_tid;
            st.next_tid += 1;
            st.total_trades += 1;
            st.trades.push(TradeInfo {
                id: tid,
                price: price_match,
                qty: fill,
                buyer,
                seller,
                asset,
            });

            self.emit_event(OrderbookEvent::Trade(TradeEvent {
                trade_id: tid,
                asset,
                price: price_match,
                qty: fill,
                buyer,
                seller,
            }))
            .expect("emit Trade failed");

            let o = &mut st.orders[mi];
            o.filled += fill;
            if o.filled >= o.qty {
                o.status = OrderStatus::Filled;
            } else {
                o.status = OrderStatus::Partial;
            }
            rem -= fill;
        }

        st.orders
            .retain(|o| o.status != OrderStatus::Filled || o.filled < o.qty);

        if rem > 0 {
            st.orders.push(Order {
                id: oid,
                trader: caller,
                side,
                asset,
                price,
                qty: rem,
                filled: 0,
                status: OrderStatus::Open,
            });
        }

        self.emit_event(OrderbookEvent::OrderPlaced(OrderPlacedEvent {
            trader: caller,
            side,
            asset,
            price,
            qty: rem,
            order_id: oid,
        }))
        .expect("emit OrderPlaced failed");

        trim_trades(&mut st);
        Ok(oid)
    }

    #[export]
    pub fn cancel_order(&mut self, oid: u64) -> Result<(), ContractError> {
        let caller = msg::source();
        let mut st = self.state.borrow_mut();
        st.agents
            .get(&caller)
            .cloned()
            .ok_or(ContractError::JoinFirst)?;

        let pos = st
            .orders
            .iter()
            .position(|o| o.id == oid && o.trader == caller)
            .ok_or(ContractError::OrderNotFound)?;

        {
            let o = &st.orders[pos];
            if o.status == OrderStatus::Filled || o.status == OrderStatus::Cancelled {
                return Err(ContractError::OrderAlreadyDone);
            }
        }
        let (rem, side, price, asset) = {
            let o = &st.orders[pos];
            (o.qty - o.filled, o.side, o.price, o.asset)
        };
        if rem > 0 {
            let ag = st.agents.get_mut(&caller).unwrap();
            match side {
                Side::Buy => ag.usd += price * rem,
                Side::Sell => add_asset(ag, asset, rem),
            }
        }
        st.orders[pos].status = OrderStatus::Cancelled;

        self.emit_event(OrderbookEvent::OrderCancelled(OrderCancelledEvent {
            trader: caller,
            order_id: oid,
        }))
        .expect("emit OrderCancelled failed");

        Ok(())
    }

    #[export]
    pub fn market_buy(&mut self, asset: Asset, qty: u64) -> Result<String, ContractError> {
        if qty == 0 {
            return Err(ContractError::BadParams);
        }
        let caller = msg::source();
        let mut st = self.state.borrow_mut();
        let ag = st
            .agents
            .get(&caller)
            .cloned()
            .ok_or(ContractError::JoinFirst)?;

        let mut sells: Vec<(usize, u64, u64, ActorId)> = st
            .orders
            .iter()
            .enumerate()
            .filter(|(_, o)| {
                o.asset == asset
                    && o.side == Side::Sell
                    && o.status != OrderStatus::Filled
                    && o.status != OrderStatus::Cancelled
                    && o.filled < o.qty
            })
            .map(|(i, o)| (i, o.price, o.qty - o.filled, o.trader))
            .collect();
        sells.sort_by_key(|t| t.1);

        // Planning pass — compute fills and total cost WITHOUT mutating state, so
        // we can reject the whole order before any balance/order changes are applied.
        let mut rem = qty;
        let mut cost = 0u64;
        let mut plan: Vec<(usize, u64, u64, ActorId)> = Vec::new();
        for &(mi, p, avail, seller) in &sells {
            if rem == 0 {
                break;
            }
            let fill = rem.min(avail);
            cost = cost
                .checked_add(p.checked_mul(fill).ok_or(ContractError::BadParams)?)
                .ok_or(ContractError::BadParams)?;
            plan.push((mi, p, fill, seller));
            rem -= fill;
        }

        let filled = qty - rem;
        if filled == 0 {
            return Err(ContractError::NoLiquidity);
        }
        if ag.usd < cost {
            return Err(ContractError::InsufficientUsd);
        }

        // Commit pass — all validation passed, now apply mutations.
        for (mi, p, fill, seller) in plan {
            let o = &mut st.orders[mi];
            o.filled += fill;
            o.status = if o.filled >= o.qty {
                OrderStatus::Filled
            } else {
                OrderStatus::Partial
            };

            if let Some(sag) = st.agents.get_mut(&seller) {
                sag.usd += p * fill;
            }
            let tid = st.next_tid;
            st.next_tid += 1;
            st.total_trades += 1;
            st.trades.push(TradeInfo {
                id: tid,
                price: p,
                qty: fill,
                buyer: caller,
                seller,
                asset,
            });

            self.emit_event(OrderbookEvent::Trade(TradeEvent {
                trade_id: tid,
                asset,
                price: p,
                qty: fill,
                buyer: caller,
                seller,
            }))
            .expect("emit Trade failed");
        }

        st.agents.get_mut(&caller).unwrap().usd -= cost;
        add_asset(st.agents.get_mut(&caller).unwrap(), asset, filled);

        st.orders
            .retain(|o| o.status != OrderStatus::Filled || o.filled < o.qty);

        trim_trades(&mut st);
        Ok(format!("Bought {} {} for {}", filled, asset.name(), cost))
    }

    #[export]
    pub fn market_sell(&mut self, asset: Asset, qty: u64) -> Result<String, ContractError> {
        if qty == 0 {
            return Err(ContractError::BadParams);
        }
        let caller = msg::source();
        let mut st = self.state.borrow_mut();
        let ag = st
            .agents
            .get(&caller)
            .cloned()
            .ok_or(ContractError::JoinFirst)?;

        if balance_of(&ag, asset) < qty {
            return Err(ContractError::InsufficientAsset);
        }
        sub_asset(st.agents.get_mut(&caller).unwrap(), asset, qty);

        let mut buys: Vec<(usize, u64, u64)> = st
            .orders
            .iter()
            .enumerate()
            .filter(|(_, o)| {
                o.asset == asset
                    && o.side == Side::Buy
                    && o.status != OrderStatus::Filled
                    && o.status != OrderStatus::Cancelled
                    && o.filled < o.qty
            })
            .map(|(i, o)| (i, o.price, o.qty - o.filled))
            .collect();
        buys.sort_by_key(|t| core::cmp::Reverse(t.1));

        let mut rem = qty;
        let mut rev = 0u64;
        for &(mi, p, avail) in &buys {
            if rem == 0 {
                break;
            }
            let fill = rem.min(avail);
            let o = &mut st.orders[mi];
            o.filled += fill;
            if o.filled >= o.qty {
                o.status = OrderStatus::Filled;
            } else {
                o.status = OrderStatus::Partial;
            }
            rev += p * fill;

            // The resting buyer escrowed their bid when placing the limit order, so
            // only credit the asset here — deducting USD again would double-charge.
            let buyer = o.trader;
            if let Some(bag) = st.agents.get_mut(&buyer) {
                add_asset(bag, asset, fill);
            }
            let tid = st.next_tid;
            st.next_tid += 1;
            st.total_trades += 1;
            st.trades.push(TradeInfo {
                id: tid,
                price: p,
                qty: fill,
                buyer,
                seller: caller,
                asset,
            });

            self.emit_event(OrderbookEvent::Trade(TradeEvent {
                trade_id: tid,
                asset,
                price: p,
                qty: fill,
                buyer,
                seller: caller,
            }))
            .expect("emit Trade failed");

            rem -= fill;
        }

        let filled = qty - rem;
        if filled == 0 {
            add_asset(st.agents.get_mut(&caller).unwrap(), asset, qty);
            return Err(ContractError::NoBuyers);
        }
        if rem > 0 {
            add_asset(st.agents.get_mut(&caller).unwrap(), asset, rem);
        }
        st.agents.get_mut(&caller).unwrap().usd += rev;

        st.orders
            .retain(|o| o.status != OrderStatus::Filled || o.filled < o.qty);

        trim_trades(&mut st);
        Ok(format!("Sold {} {} for {}", filled, asset.name(), rev))
    }

    #[export]
    pub fn get_portfolio(&self) -> (u64, u64, u64, u64) {
        let caller = msg::source();
        let st = self.state.borrow();
        if let Some(ag) = st.agents.get(&caller) {
            (ag.usd, ag.btc, ag.eth, ag.vara)
        } else {
            (0, 0, 0, 0)
        }
    }

    // Returns (bids, asks) as (price, qty) levels.
    #[export]
    pub fn get_orderbook(&self, asset: Asset) -> (Vec<(u64, u64)>, Vec<(u64, u64)>) {
        let st = self.state.borrow();
        let mut buys: Vec<(u64, u64)> = Vec::new();
        let mut sells: Vec<(u64, u64)> = Vec::new();
        for o in &st.orders {
            if o.asset != asset
                || o.status == OrderStatus::Filled
                || o.status == OrderStatus::Cancelled
                || o.filled >= o.qty
            {
                continue;
            }
            let rem = o.qty - o.filled;
            let tgt = if o.side == Side::Buy {
                &mut buys
            } else {
                &mut sells
            };
            if let Some(ex) = tgt.iter_mut().find(|(p, _)| *p == o.price) {
                ex.1 += rem;
            } else {
                tgt.push((o.price, rem));
            }
        }
        buys.sort_by_key(|t| core::cmp::Reverse(t.0));
        sells.sort_by_key(|t| t.0);
        (
            buys.into_iter().take(10).collect(),
            sells.into_iter().take(10).collect(),
        )
    }

    #[export]
    pub fn get_my_orders(&self) -> Vec<(u64, Side, Asset, u64, u64, u64, OrderStatus)> {
        let caller = msg::source();
        let st = self.state.borrow();
        st.orders
            .iter()
            .filter(|o| {
                o.trader == caller
                    && o.status != OrderStatus::Filled
                    && o.status != OrderStatus::Cancelled
            })
            .map(|o| (o.id, o.side, o.asset, o.price, o.qty, o.filled, o.status))
            .collect()
    }

    #[export]
    pub fn get_trades(&self, asset: Asset, limit: u32) -> Vec<(u64, u64, u64, ActorId, ActorId)> {
        let st = self.state.borrow();
        let limit = limit.min(MAX_PAGE) as usize;
        st.trades
            .iter()
            .rev()
            .filter(|t| t.asset == asset)
            .take(limit)
            .map(|t| (t.id, t.price, t.qty, t.buyer, t.seller))
            .collect()
    }

    #[export]
    pub fn get_leaderboard(&self, limit: u32) -> Vec<LeaderEntry> {
        let st = self.state.borrow();
        let limit = limit.min(MAX_PAGE) as usize;
        let mut v: Vec<LeaderEntry> = st
            .agents
            .values()
            .map(|ag| {
                let nw = ag.usd + ag.btc / 1000 + ag.eth / 100 + ag.vara / 100000;
                LeaderEntry {
                    id: ag.id,
                    name: ag.name.clone(),
                    strategy: ag.strategy,
                    usd: ag.usd,
                    net_worth: nw,
                }
            })
            .collect();
        v.sort_by_key(|e| core::cmp::Reverse(e.net_worth));
        v.truncate(limit);
        v
    }

    #[export]
    pub fn get_status(&self) -> (u32, u64, u32, bool, u32) {
        let st = self.state.borrow();
        (
            st.agents.len() as u32,
            st.total_trades,
            st.orders.len() as u32,
            st.running,
            st.cycle,
        )
    }

    #[export]
    pub fn tick(&mut self) -> Result<String, ContractError> {
        let mut st = self.state.borrow_mut();
        st.cycle += 1;
        Ok(format!("Tick #{}", st.cycle))
    }

    #[export]
    pub fn start_autopilot(&mut self) {
        let mut st = self.state.borrow_mut();
        if msg::source() != st.admin {
            return;
        }
        if !st.running {
            st.running = true;
        }
    }

    #[export]
    pub fn challenge(&mut self, opponent: ActorId, amount: u64) -> Result<u32, ContractError> {
        let caller = msg::source();
        let st = self.state.borrow();
        let ag = st
            .agents
            .get(&caller)
            .cloned()
            .ok_or(ContractError::JoinFirst)?;
        if ag.usd < amount {
            return Err(ContractError::InsufficientUsd);
        }
        if !st.agents.contains_key(&opponent) {
            return Err(ContractError::JoinFirst);
        }
        // Placeholder A2A primitive: validates the challenge is well-formed but does
        // not stake/escrow funds yet. Deducting here would destroy the caller's USD
        // with no settlement path, so leave balances untouched until stakes ship.
        Ok(0)
    }

    #[export]
    pub fn signal_collab(&mut self, _partner: ActorId, _note: String) {
        // Placeholder A2A primitive. It intentionally does not create an agent for
        // `partner`: doing so would insert a zero-balance record that makes `join`
        // return early forever, permanently locking that address out of funding.
    }

    /// Admin-only: register the VFT program ID that backs a custodied balance.
    /// Must be set before deposit/withdraw can move real tokens for that kind.
    #[export]
    pub fn set_token(&mut self, kind: TokenKind, address: ActorId) -> Result<(), ContractError> {
        let mut st = self.state.borrow_mut();
        if msg::source() != st.admin {
            return Err(ContractError::NotAdmin);
        }
        st.set_token_of(kind, address);
        Ok(())
    }

    #[export]
    pub fn get_token(&self, kind: TokenKind) -> ActorId {
        self.state.borrow().token_of(kind)
    }

    /// All four token registrations as (usd, btc, eth, vara) for the UI/agents.
    #[export]
    pub fn get_tokens(&self) -> (ActorId, ActorId, ActorId, ActorId) {
        let st = self.state.borrow();
        (st.token_usd, st.token_btc, st.token_eth, st.token_vara)
    }

    /// Move real VFT tokens from the caller into the DEX vault, crediting their
    /// internal balance. The caller must have `approve`d the DEX on the token
    /// program for at least `amount` first. Credits only after the on-chain
    /// transfer succeeds, so the internal balance stays fully token-backed.
    #[export]
    pub async fn deposit(&mut self, kind: TokenKind, amount: u64) -> Result<u64, ContractError> {
        if amount == 0 {
            return Err(ContractError::ZeroAmount);
        }
        let (token, is_agent) = {
            let st = self.state.borrow();
            (st.token_of(kind), st.agents.contains_key(&msg::source()))
        };
        if token == ActorId::zero() {
            return Err(ContractError::BadParams);
        }
        if !is_agent {
            return Err(ContractError::JoinFirst);
        }
        let caller = msg::source();
        let dex = exec::program_id();
        let value = U256::from(amount);
        let payload = vft_route("TransferFrom", (caller, dex, value).encode());
        // Forward half of remaining gas; the rest runs our post-await continuation.
        let gas = exec::gas_available() / 2;
        let ok = msg::send_for_reply_as::<RawPayload, SailsReply<bool>>(
            token,
            RawPayload(payload),
            gas as u128,
            0,
        )
        .map_err(|_| ContractError::AgentCallFailed)?
        .await
        .map_err(|_| ContractError::AgentCallFailed)?
        .0;
        if !ok {
            return Err(ContractError::AgentCallFailed);
        }
        let mut st = self.state.borrow_mut();
        if let Some(ag) = st.agents.get_mut(&caller) {
            credit_kind(ag, kind, amount);
        }
        Ok(amount)
    }

    /// Withdraw real VFT tokens from the DEX vault back to the caller. Debits the
    /// internal balance first, then transfers on-chain; if the transfer fails the
    /// debit is reverted so funds are never silently lost.
    #[export]
    pub async fn withdraw(&mut self, kind: TokenKind, amount: u64) -> Result<u64, ContractError> {
        if amount == 0 {
            return Err(ContractError::ZeroAmount);
        }
        let caller = msg::source();
        let token = {
            let mut st = self.state.borrow_mut();
            let token = st.token_of(kind);
            if token == ActorId::zero() {
                return Err(ContractError::BadParams);
            }
            let ag = st.agents.get_mut(&caller).ok_or(ContractError::JoinFirst)?;
            if kind_balance(ag, kind) < amount {
                return Err(ContractError::InsufficientAsset);
            }
            debit_kind(ag, kind, amount);
            token
        };
        let value = U256::from(amount);
        // VFT `transfer(to, value)` from the DEX vault back to the caller.
        let payload = vft_route("Transfer", (caller, value).encode());
        // Forward half of remaining gas; the rest runs our post-await continuation.
        let gas = exec::gas_available() / 2;
        let result = msg::send_for_reply_as::<RawPayload, SailsReply<bool>>(
            token,
            RawPayload(payload),
            gas as u128,
            0,
        );
        let ok = match result {
            Ok(fut) => fut.await.map(|r| r.0).unwrap_or(false),
            Err(_) => false,
        };
        if !ok {
            // Transfer failed — give the caller their internal balance back.
            let mut st = self.state.borrow_mut();
            if let Some(ag) = st.agents.get_mut(&caller) {
                credit_kind(ag, kind, amount);
            }
            return Err(ContractError::AgentCallFailed);
        }
        Ok(amount)
    }

    #[export]
    pub async fn call_agent_service(
        &mut self,
        target: ActorId,
        payload: Vec<u8>,
        gas_limit: u64,
    ) -> Result<Vec<u8>, ContractError> {
        let reply = msg::send_for_reply_as::<RawPayload, SailsReply<Vec<u8>>>(
            target,
            RawPayload(payload),
            gas_limit as u128,
            0,
        )
        .map_err(|_| ContractError::AgentCallFailed)?
        .await
        .map_err(|_| ContractError::AgentCallFailed)?
        .0;
        Ok(reply)
    }
}
