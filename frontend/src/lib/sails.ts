/* eslint-disable */

import { GearApi, BaseGearProgram } from '@gear-js/api';
import type { HexString } from '@gear-js/api';
import { TypeRegistry } from '@polkadot/types';
import { TransactionBuilder, ActorId, QueryBuilder, getServiceNamePrefix, getFnNamePrefix, ZERO_ADDRESS } from 'sails-js';

export class SailsProgram {
  public readonly registry: TypeRegistry;
  public readonly spot: Spot;
  public readonly amm: Amm;
  public readonly perpsV1: PerpsV1;
  private _program?: BaseGearProgram;

  constructor(public api: GearApi, programId?: `0x${string}`) {
    const types: Record<string, any> = {
      SpotError: {"_enum":["NotAdmin","BadParams","PairExists","NoPair","PairInactive","BookFull","NoOrder","NotOwner","NothingToClaim","TransferFailed","Paused","SlippageExceeded","Overflow","DecimalsMismatch","NotPendingAdmin"]},
      Side: {"_enum":["Buy","Sell"]},
      SpotOrder: {"id":"u64","pair_id":"u64","trader":"[u8;32]","side":"Side","price":"u128","qty":"u128","filled":"u128","status":"SpotStatus","escrowed":"u128","released":"u128"},
      SpotStatus: {"_enum":["Open","PartiallyFilled"]},
      SpotPair: {"id":"u64","base":"[u8;32]","quote":"[u8;32]","base_dec":"u8","quote_dec":"u8","active":"bool"},
      AmmError: {"_enum":["NotAdmin","BadParams","PoolExists","NoPool","PoolInactive","TooManyPools","TransferFailed","Paused","SlippageExceeded","InsufficientShares","AmountTooSmall","Overflow","DecimalsMismatch"]},
      AmmPool: {"id":"u64","token_a":"[u8;32]","token_b":"[u8;32]","dec_a":"u8","dec_b":"u8","reserve_a":"u128","reserve_b":"u128","total_shares":"u128","active":"bool"},
      PerpsError: {"_enum":["NotAdmin","NotKeeper","BadParams","NoMarket","MarketInactive","StaleMark","LeverageTooHigh","InsufficientMargin","PositionNotFound","NotLiquidatable","BookFull","TransferFailed","NoCollateral","OiCapExceeded","Paused","MarkDeviationTooLarge","InsufficientCoverage","Overflow"]},
      PerpMarket: {"id":"u64","symbol":"String","mark":"u128","mark_block":"u32","active":"bool","long_oi":"u128","short_oi":"u128","max_oi":"u128","cum_funding":"i128","funding_block":"u32"},
    }

    this.registry = new TypeRegistry();
    this.registry.setKnownTypes({ types });
    this.registry.register(types);
    if (programId) {
      this._program = new BaseGearProgram(programId, api);
    }

    this.spot = new Spot(this);
    this.amm = new Amm(this);
    this.perpsV1 = new PerpsV1(this);
  }

  public get programId(): `0x${string}` {
    if (!this._program) throw new Error(`Program ID is not set`);
    return this._program.id;
  }

  newCtorFromCode(code: Uint8Array | Buffer | HexString): TransactionBuilder<null> {
    const builder = new TransactionBuilder<null>(
      this.api,
      this.registry,
      'upload_program',
      null,
      'New',
      null,
      null,
      'String',
      code,
      async (programId) =>  {
        this._program = await BaseGearProgram.new(programId, this.api);
      }
    );
    return builder;
  }

  newCtorFromCodeId(codeId: `0x${string}`) {
    const builder = new TransactionBuilder<null>(
      this.api,
      this.registry,
      'create_program',
      null,
      'New',
      null,
      null,
      'String',
      codeId,
      async (programId) =>  {
        this._program = await BaseGearProgram.new(programId, this.api);
      }
    );
    return builder;
  }
}

export class Spot {
  constructor(private _program: SailsProgram) {}

  /**
   * Accept a pending admin handover. Callable only by the proposed account.
  */
  public acceptAdmin(): TransactionBuilder<{ ok: null } | { err: SpotError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: null } | { err: SpotError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Spot',
      'AcceptAdmin',
      null,
      null,
      'Result<Null, SpotError>',
      this._program.programId,
    );
  }

  /**
   * Cancel a resting order and refund its unfilled escrow to the caller's
   * claimable balance. Never gated on the pause switch.
  */
  public cancelOrder(order_id: number | string | bigint): TransactionBuilder<{ ok: null } | { err: SpotError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: null } | { err: SpotError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Spot',
      'CancelOrder',
      order_id,
      'u64',
      'Result<Null, SpotError>',
      this._program.programId,
    );
  }

  /**
   * Stop accepting new orders on a pair. Existing orders can still be cancelled and
   * proceeds withdrawn. Reversible with `relist_pair` (audit M-14).
  */
  public delistPair(pair_id: number | string | bigint): TransactionBuilder<{ ok: null } | { err: SpotError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: null } | { err: SpotError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Spot',
      'DelistPair',
      pair_id,
      'u64',
      'Result<Null, SpotError>',
      this._program.programId,
    );
  }

  /**
   * Curate a new TOKEN/quote market. Admin-only (multisig on mainnet).
   * 
   * `base_dec`/`quote_dec` are read back from each token's own `VftMetadata`
   * service and rejected on mismatch — a wrong value would misprice the entire
   * market by a power of ten, and self-attestation is not a control (audit M-14).
  */
  public listPair(base: ActorId, quote: ActorId, base_dec: number, quote_dec: number): TransactionBuilder<{ ok: number | string | bigint } | { err: SpotError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: number | string | bigint } | { err: SpotError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Spot',
      'ListPair',
      [base, quote, base_dec, quote_dec],
      '([u8;32], [u8;32], u8, u8)',
      'Result<u64, SpotError>',
      this._program.programId,
    );
  }

  /**
   * Market buy up to `qty` base, spending at most `max_quote` quote tokens and
   * requiring at least `min_base_out` base in return.
   * 
   * `min_base_out` is the slippage bound (audit H-03): without it a taker sweeps
   * whatever asks happen to exist, which on a thin book is an invitation to pull
   * quotes and leave a lowball. When the bound is not met the whole budget is
   * credited back and nothing is filled.
  */
  public marketBuy(pair_id: number | string | bigint, qty: number | string | bigint, max_quote: number | string | bigint, min_base_out: number | string | bigint): TransactionBuilder<{ ok: number | string | bigint } | { err: SpotError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: number | string | bigint } | { err: SpotError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Spot',
      'MarketBuy',
      [pair_id, qty, max_quote, min_base_out],
      '(u64, u128, u128, u128)',
      'Result<u64, SpotError>',
      this._program.programId,
    );
  }

  /**
   * Market sell `qty` base into the bids, highest-first, requiring at least
   * `min_quote_out` quote in return (audit H-03). Escrows the base up front and
   * refunds everything if the bound is not met.
  */
  public marketSell(pair_id: number | string | bigint, qty: number | string | bigint, min_quote_out: number | string | bigint): TransactionBuilder<{ ok: number | string | bigint } | { err: SpotError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: number | string | bigint } | { err: SpotError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Spot',
      'MarketSell',
      [pair_id, qty, min_quote_out],
      '(u64, u128, u128)',
      'Result<u64, SpotError>',
      this._program.programId,
    );
  }

  /**
   * Place a limit order. Escrows the caller's real tokens (a quote-token
   * `TransferFrom` for a buy, base-token for a sell — requires a prior `approve`),
   * then crosses the book by price-time priority, crediting fills to claimable
   * balances. Any unfilled remainder rests.
   * 
   * Every check that can precede the escrow does; the only post-await failure is
   * the capacity re-check, which credits the escrow back before returning
   * (audit C-03, M-08).
  */
  public placeLimit(pair_id: number | string | bigint, side: Side, price: number | string | bigint, qty: number | string | bigint): TransactionBuilder<{ ok: number | string | bigint } | { err: SpotError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: number | string | bigint } | { err: SpotError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Spot',
      'PlaceLimit',
      [pair_id, side, price, qty],
      '(u64, Side, u128, u128)',
      'Result<u64, SpotError>',
      this._program.programId,
    );
  }

  /**
   * Propose a new admin. Takes effect only when that account calls `accept_admin`,
   * so a typo is recoverable rather than terminal (audit H-05).
  */
  public proposeAdmin(new_admin: ActorId): TransactionBuilder<{ ok: null } | { err: SpotError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: null } | { err: SpotError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Spot',
      'ProposeAdmin',
      new_admin,
      '[u8;32]',
      'Result<Null, SpotError>',
      this._program.programId,
    );
  }

  /**
   * Re-open a delisted pair. Admin-only.
  */
  public relistPair(pair_id: number | string | bigint): TransactionBuilder<{ ok: null } | { err: SpotError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: null } | { err: SpotError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Spot',
      'RelistPair',
      pair_id,
      'u64',
      'Result<Null, SpotError>',
      this._program.programId,
    );
  }

  /**
   * Halt or resume trading. Cancel and withdraw are deliberately never gated on
   * this, so pausing during an incident cannot trap user funds (audit H-08).
  */
  public setPaused(paused: boolean): TransactionBuilder<{ ok: null } | { err: SpotError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: null } | { err: SpotError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Spot',
      'SetPaused',
      paused,
      'bool',
      'Result<Null, SpotError>',
      this._program.programId,
    );
  }

  /**
   * Sweep accumulated rounding dust for a token to the admin's claimable balance.
   * Dust is real, already-held tokens that no claim references (audit M-06).
  */
  public sweepDust(token: ActorId): TransactionBuilder<{ ok: number | string | bigint } | { err: SpotError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: number | string | bigint } | { err: SpotError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Spot',
      'SweepDust',
      token,
      '[u8;32]',
      'Result<u128, SpotError>',
      this._program.programId,
    );
  }

  /**
   * Withdraw `amount` of the caller's claimable `token` to their wallet, or the
   * full balance when `amount` is `None` (audit L-01). Debits optimistically and
   * restores the claim if the on-chain transfer fails. Never gated on the pause.
  */
  public withdraw(token: ActorId, amount: number | string | bigint | null): TransactionBuilder<{ ok: number | string | bigint } | { err: SpotError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: number | string | bigint } | { err: SpotError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Spot',
      'Withdraw',
      [token, amount],
      '([u8;32], Option<u128>)',
      'Result<u128, SpotError>',
      this._program.programId,
    );
  }

  public getAdmin(): QueryBuilder<[ActorId, ActorId]> {
    return new QueryBuilder<[ActorId, ActorId]>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Spot',
      'GetAdmin',
      null,
      null,
      '([u8;32], [u8;32])',
    );
  }

  /**
   * The caller's withdrawable balance for a given token program.
  */
  public getClaim(token: ActorId): QueryBuilder<bigint> {
    return new QueryBuilder<bigint>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Spot',
      'GetClaim',
      token,
      '[u8;32]',
      'u128',
    );
  }

  /**
   * The caller's resting orders, paginated. Filled and cancelled orders are not
   * retained in state — their history is in the event log (audit H-02, M-02).
  */
  public getMyOrders(offset: number, limit: number): QueryBuilder<Array<SpotOrder>> {
    return new QueryBuilder<Array<SpotOrder>>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Spot',
      'GetMyOrders',
      [offset, limit],
      '(u32, u32)',
      'Vec<SpotOrder>',
    );
  }

  /**
   * Aggregated resting depth for a pair: (bids desc by price, asks asc by price),
   * each level `(price, remaining_qty)`, capped at `depth` levels per side.
  */
  public getOrderbook(pair_id: number | string | bigint, depth: number): QueryBuilder<[Array<[number | string | bigint, number | string | bigint]>, Array<[number | string | bigint, number | string | bigint]>]> {
    return new QueryBuilder<[Array<[number | string | bigint, number | string | bigint]>, Array<[number | string | bigint, number | string | bigint]>]>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Spot',
      'GetOrderbook',
      [pair_id, depth],
      '(u64, u32)',
      '(Vec<(u128, u128)>, Vec<(u128, u128)>)',
    );
  }

  public getPair(pair_id: number | string | bigint): QueryBuilder<SpotPair | null> {
    return new QueryBuilder<SpotPair | null>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Spot',
      'GetPair',
      pair_id,
      'u64',
      'Option<SpotPair>',
    );
  }

  /**
   * Curated markets, paginated (audit L-05).
  */
  public getPairs(offset: number, limit: number): QueryBuilder<Array<SpotPair>> {
    return new QueryBuilder<Array<SpotPair>>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Spot',
      'GetPairs',
      [offset, limit],
      '(u32, u32)',
      'Vec<SpotPair>',
    );
  }

  /**
   * Escrow, dust, and reserve held for a token. With the token's own
   * `balanceOf(program)` this lets a monitor assert the solvency invariant
   * without replaying the book (audit M-17).
  */
  public getSolvency(token: ActorId): QueryBuilder<[number | string | bigint, number | string | bigint, number | string | bigint]> {
    return new QueryBuilder<[number | string | bigint, number | string | bigint, number | string | bigint]>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Spot',
      'GetSolvency',
      token,
      '[u8;32]',
      '(u128, u128, u128)',
    );
  }

  public isPaused(): QueryBuilder<boolean> {
    return new QueryBuilder<boolean>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Spot',
      'IsPaused',
      null,
      null,
      'bool',
    );
  }

  public pairCount(): QueryBuilder<bigint> {
    return new QueryBuilder<bigint>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Spot',
      'PairCount',
      null,
      null,
      'u64',
    );
  }

  public restingOrderCount(): QueryBuilder<bigint> {
    return new QueryBuilder<bigint>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Spot',
      'RestingOrderCount',
      null,
      null,
      'u64',
    );
  }

  public subscribeToPairListedEvent(callback: (data: { pair_id: number | string | bigint; base: ActorId; quote: ActorId; base_dec: number; quote_dec: number }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Spot' && getFnNamePrefix(payload) === 'PairListed') {
        callback(this._program.registry.createType('(String, String, {"pair_id":"u64","base":"[u8;32]","quote":"[u8;32]","base_dec":"u8","quote_dec":"u8"})', message.payload)[2].toJSON() as unknown as { pair_id: number | string | bigint; base: ActorId; quote: ActorId; base_dec: number; quote_dec: number });
      }
    });
  }

  public subscribeToPairDelistedEvent(callback: (data: { pair_id: number | string | bigint }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Spot' && getFnNamePrefix(payload) === 'PairDelisted') {
        callback(this._program.registry.createType('(String, String, {"pair_id":"u64"})', message.payload)[2].toJSON() as unknown as { pair_id: number | string | bigint });
      }
    });
  }

  public subscribeToPairRelistedEvent(callback: (data: { pair_id: number | string | bigint }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Spot' && getFnNamePrefix(payload) === 'PairRelisted') {
        callback(this._program.registry.createType('(String, String, {"pair_id":"u64"})', message.payload)[2].toJSON() as unknown as { pair_id: number | string | bigint });
      }
    });
  }

  public subscribeToOrderPlacedEvent(callback: (data: { order_id: number | string | bigint; pair_id: number | string | bigint; trader: ActorId; side: Side; price: number | string | bigint; qty: number | string | bigint }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Spot' && getFnNamePrefix(payload) === 'OrderPlaced') {
        callback(this._program.registry.createType('(String, String, {"order_id":"u64","pair_id":"u64","trader":"[u8;32]","side":"Side","price":"u128","qty":"u128"})', message.payload)[2].toJSON() as unknown as { order_id: number | string | bigint; pair_id: number | string | bigint; trader: ActorId; side: Side; price: number | string | bigint; qty: number | string | bigint });
      }
    });
  }

  public subscribeToTradeEvent(callback: (data: { pair_id: number | string | bigint; taker_order: number | string | bigint; maker_order: number | string | bigint; buyer: ActorId; seller: ActorId; price: number | string | bigint; qty: number | string | bigint }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Spot' && getFnNamePrefix(payload) === 'Trade') {
        callback(this._program.registry.createType('(String, String, {"pair_id":"u64","taker_order":"u64","maker_order":"u64","buyer":"[u8;32]","seller":"[u8;32]","price":"u128","qty":"u128"})', message.payload)[2].toJSON() as unknown as { pair_id: number | string | bigint; taker_order: number | string | bigint; maker_order: number | string | bigint; buyer: ActorId; seller: ActorId; price: number | string | bigint; qty: number | string | bigint });
      }
    });
  }

  public subscribeToOrderCancelledEvent(callback: (data: { order_id: number | string | bigint; pair_id: number | string | bigint; trader: ActorId; refunded: number | string | bigint }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Spot' && getFnNamePrefix(payload) === 'OrderCancelled') {
        callback(this._program.registry.createType('(String, String, {"order_id":"u64","pair_id":"u64","trader":"[u8;32]","refunded":"u128"})', message.payload)[2].toJSON() as unknown as { order_id: number | string | bigint; pair_id: number | string | bigint; trader: ActorId; refunded: number | string | bigint });
      }
    });
  }

  public subscribeToOrderClosedEvent(callback: (data: { order_id: number | string | bigint; pair_id: number | string | bigint; trader: ActorId; filled: number | string | bigint }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Spot' && getFnNamePrefix(payload) === 'OrderClosed') {
        callback(this._program.registry.createType('(String, String, {"order_id":"u64","pair_id":"u64","trader":"[u8;32]","filled":"u128"})', message.payload)[2].toJSON() as unknown as { order_id: number | string | bigint; pair_id: number | string | bigint; trader: ActorId; filled: number | string | bigint });
      }
    });
  }

  public subscribeToWithdrawnEvent(callback: (data: { who: ActorId; token: ActorId; amount: number | string | bigint }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Spot' && getFnNamePrefix(payload) === 'Withdrawn') {
        callback(this._program.registry.createType('(String, String, {"who":"[u8;32]","token":"[u8;32]","amount":"u128"})', message.payload)[2].toJSON() as unknown as { who: ActorId; token: ActorId; amount: number | string | bigint });
      }
    });
  }

  public subscribeToDustSweptEvent(callback: (data: { token: ActorId; amount: number | string | bigint }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Spot' && getFnNamePrefix(payload) === 'DustSwept') {
        callback(this._program.registry.createType('(String, String, {"token":"[u8;32]","amount":"u128"})', message.payload)[2].toJSON() as unknown as { token: ActorId; amount: number | string | bigint });
      }
    });
  }

  public subscribeToPausedSetEvent(callback: (data: { paused: boolean }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Spot' && getFnNamePrefix(payload) === 'PausedSet') {
        callback(this._program.registry.createType('(String, String, {"paused":"bool"})', message.payload)[2].toJSON() as unknown as { paused: boolean });
      }
    });
  }

  public subscribeToAdminProposedEvent(callback: (data: { pending: ActorId }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Spot' && getFnNamePrefix(payload) === 'AdminProposed') {
        callback(this._program.registry.createType('(String, String, {"pending":"[u8;32]"})', message.payload)[2].toJSON() as unknown as { pending: ActorId });
      }
    });
  }

  public subscribeToAdminChangedEvent(callback: (data: { admin: ActorId }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Spot' && getFnNamePrefix(payload) === 'AdminChanged') {
        callback(this._program.registry.createType('(String, String, {"admin":"[u8;32]"})', message.payload)[2].toJSON() as unknown as { admin: ActorId });
      }
    });
  }
}

export class Amm {
  constructor(private _program: SailsProgram) {}

  /**
   * Deposit both tokens and receive LP shares.
   * 
   * `min_shares` is the caller's bound: deposits are minted at the pool's ratio at
   * execution time, which another trade can move between signing and landing.
   * Requires a prior `approve` of each token.
  */
  public addLiquidity(pool_id: number | string | bigint, amount_a: number | string | bigint, amount_b: number | string | bigint, min_shares: number | string | bigint): TransactionBuilder<{ ok: number | string | bigint } | { err: AmmError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: number | string | bigint } | { err: AmmError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Amm',
      'AddLiquidity',
      [pool_id, amount_a, amount_b, min_shares],
      '(u64, u128, u128, u128)',
      'Result<u128, AmmError>',
      this._program.programId,
    );
  }

  /**
   * Create a pool for a token pair. Admin-only, like spot listing: a pool is a
   * curated market, not something anyone can conjure.
   * 
   * Decimals are verified against each token's own `VftMetadata` and rejected on
   * mismatch, for the same reason listing does it (audit M-14).
  */
  public createPool(token_a: ActorId, token_b: ActorId, dec_a: number, dec_b: number): TransactionBuilder<{ ok: number | string | bigint } | { err: AmmError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: number | string | bigint } | { err: AmmError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Amm',
      'CreatePool',
      [token_a, token_b, dec_a, dec_b],
      '([u8;32], [u8;32], u8, u8)',
      'Result<u64, AmmError>',
      this._program.programId,
    );
  }

  /**
   * Burn shares and take back the corresponding fraction of both reserves,
   * including the fees accrued into them.
   * 
   * Credited to claimable balances (withdraw with `Spot/Withdraw`), and never
   * gated on the pause or on the pool being active: a provider must always be
   * able to leave.
  */
  public removeLiquidity(pool_id: number | string | bigint, shares: number | string | bigint, min_a: number | string | bigint, min_b: number | string | bigint): TransactionBuilder<{ ok: [number | string | bigint, number | string | bigint] } | { err: AmmError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: [number | string | bigint, number | string | bigint] } | { err: AmmError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Amm',
      'RemoveLiquidity',
      [pool_id, shares, min_a, min_b],
      '(u64, u128, u128, u128)',
      'Result<(u128, u128), AmmError>',
      this._program.programId,
    );
  }

  /**
   * Stop or resume deposits and swaps on a pool. Removing liquidity is never
   * blocked, so delisting cannot strand a provider's funds.
  */
  public setPoolActive(pool_id: number | string | bigint, active: boolean): TransactionBuilder<{ ok: null } | { err: AmmError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: null } | { err: AmmError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Amm',
      'SetPoolActive',
      [pool_id, active],
      '(u64, bool)',
      'Result<Null, AmmError>',
      this._program.programId,
    );
  }

  /**
   * Swap `amount_in` of `token_in` for the other token, receiving at least
   * `min_amount_out`. Requires a prior `approve` of `token_in`.
   * 
   * The output is credited to the caller's claimable balance, on the same
   * settlement path as spot, so no swap depends on a transfer succeeding mid-way.
  */
  public swap(pool_id: number | string | bigint, token_in: ActorId, amount_in: number | string | bigint, min_amount_out: number | string | bigint): TransactionBuilder<{ ok: number | string | bigint } | { err: AmmError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: number | string | bigint } | { err: AmmError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Amm',
      'Swap',
      [pool_id, token_in, amount_in, min_amount_out],
      '(u64, [u8;32], u128, u128)',
      'Result<u128, AmmError>',
      this._program.programId,
    );
  }

  public getPool(pool_id: number | string | bigint): QueryBuilder<AmmPool | null> {
    return new QueryBuilder<AmmPool | null>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Amm',
      'GetPool',
      pool_id,
      'u64',
      'Option<AmmPool>',
    );
  }

  public getPools(offset: number, limit: number): QueryBuilder<Array<AmmPool>> {
    return new QueryBuilder<Array<AmmPool>>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Amm',
      'GetPools',
      [offset, limit],
      '(u32, u32)',
      'Vec<AmmPool>',
    );
  }

  /**
   * The caller's LP shares in a pool, and what they are currently worth.
  */
  public getPosition(pool_id: number | string | bigint): QueryBuilder<[number | string | bigint, number | string | bigint, number | string | bigint]> {
    return new QueryBuilder<[number | string | bigint, number | string | bigint, number | string | bigint]>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Amm',
      'GetPosition',
      pool_id,
      'u64',
      '(u128, u128, u128)',
    );
  }

  /**
   * Quote a swap without executing it: `(amount_out, fee)`.
  */
  public quoteSwap(pool_id: number | string | bigint, token_in: ActorId, amount_in: number | string | bigint): QueryBuilder<[number | string | bigint, number | string | bigint]> {
    return new QueryBuilder<[number | string | bigint, number | string | bigint]>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Amm',
      'QuoteSwap',
      [pool_id, token_in, amount_in],
      '(u64, [u8;32], u128)',
      '(u128, u128)',
    );
  }

  public subscribeToPoolCreatedEvent(callback: (data: { pool_id: number | string | bigint; token_a: ActorId; token_b: ActorId }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Amm' && getFnNamePrefix(payload) === 'PoolCreated') {
        callback(this._program.registry.createType('(String, String, {"pool_id":"u64","token_a":"[u8;32]","token_b":"[u8;32]"})', message.payload)[2].toJSON() as unknown as { pool_id: number | string | bigint; token_a: ActorId; token_b: ActorId });
      }
    });
  }

  public subscribeToPoolActiveSetEvent(callback: (data: { pool_id: number | string | bigint; active: boolean }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Amm' && getFnNamePrefix(payload) === 'PoolActiveSet') {
        callback(this._program.registry.createType('(String, String, {"pool_id":"u64","active":"bool"})', message.payload)[2].toJSON() as unknown as { pool_id: number | string | bigint; active: boolean });
      }
    });
  }

  public subscribeToLiquidityAddedEvent(callback: (data: { pool_id: number | string | bigint; provider: ActorId; amount_a: number | string | bigint; amount_b: number | string | bigint; shares: number | string | bigint }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Amm' && getFnNamePrefix(payload) === 'LiquidityAdded') {
        callback(this._program.registry.createType('(String, String, {"pool_id":"u64","provider":"[u8;32]","amount_a":"u128","amount_b":"u128","shares":"u128"})', message.payload)[2].toJSON() as unknown as { pool_id: number | string | bigint; provider: ActorId; amount_a: number | string | bigint; amount_b: number | string | bigint; shares: number | string | bigint });
      }
    });
  }

  public subscribeToLiquidityRemovedEvent(callback: (data: { pool_id: number | string | bigint; provider: ActorId; amount_a: number | string | bigint; amount_b: number | string | bigint; shares: number | string | bigint }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Amm' && getFnNamePrefix(payload) === 'LiquidityRemoved') {
        callback(this._program.registry.createType('(String, String, {"pool_id":"u64","provider":"[u8;32]","amount_a":"u128","amount_b":"u128","shares":"u128"})', message.payload)[2].toJSON() as unknown as { pool_id: number | string | bigint; provider: ActorId; amount_a: number | string | bigint; amount_b: number | string | bigint; shares: number | string | bigint });
      }
    });
  }

  public subscribeToSwappedEvent(callback: (data: { pool_id: number | string | bigint; trader: ActorId; token_in: ActorId; amount_in: number | string | bigint; token_out: ActorId; amount_out: number | string | bigint; fee: number | string | bigint }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Amm' && getFnNamePrefix(payload) === 'Swapped') {
        callback(this._program.registry.createType('(String, String, {"pool_id":"u64","trader":"[u8;32]","token_in":"[u8;32]","amount_in":"u128","token_out":"[u8;32]","amount_out":"u128","fee":"u128"})', message.payload)[2].toJSON() as unknown as { pool_id: number | string | bigint; trader: ActorId; token_in: ActorId; amount_in: number | string | bigint; token_out: ActorId; amount_out: number | string | bigint; fee: number | string | bigint });
      }
    });
  }
}

export class PerpsV1 {
  constructor(private _program: SailsProgram) {}

  /**
   * Admin: list a perp market. `max_oi` is required and must be non-zero — the
   * reserve's exposure is bounded at creation, not by a remembered follow-up
   * (audit M-03).
  */
  public addMarket($symbol: string, max_oi: number | string | bigint): TransactionBuilder<{ ok: number | string | bigint } | { err: PerpsError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: number | string | bigint } | { err: PerpsError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'PerpsV1',
      'AddMarket',
      [$symbol, max_oi],
      '(String, u128)',
      'Result<u64, PerpsError>',
      this._program.programId,
    );
  }

  /**
   * Close your position, settling PnL and funding against the reserve and
   * crediting the payout to your claimable collateral (withdraw via
   * `Spot/Withdraw`). Never gated on the pause switch, and never gated on a live
   * keeper once the feed has been dead past `MARK_EXIT_AGE`.
  */
  public closePosition(position_id: number | string | bigint): TransactionBuilder<{ ok: [number | string | bigint, number | string | bigint] } | { err: PerpsError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: [number | string | bigint, number | string | bigint] } | { err: PerpsError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'PerpsV1',
      'ClosePosition',
      position_id,
      'u64',
      'Result<(u128, i128), PerpsError>',
      this._program.programId,
    );
  }

  /**
   * Admin: fund the house reserve with real collateral (requires a prior `approve`).
  */
  public fundReserve(amount: number | string | bigint): TransactionBuilder<{ ok: number | string | bigint } | { err: PerpsError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: number | string | bigint } | { err: PerpsError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'PerpsV1',
      'FundReserve',
      amount,
      'u128',
      'Result<u128, PerpsError>',
      this._program.programId,
    );
  }

  /**
   * Permissionless liquidation once equity falls to maintenance margin.
   * 
   * The liquidator's fee is paid from residual equity and topped up from the
   * reserve when equity has gapped away. Capping the fee at residual equity meant
   * it vanished exactly when liquidation mattered most, so nobody would run a bot
   * for it (audit L-07).
  */
  public liquidate(position_id: number | string | bigint): TransactionBuilder<{ ok: null } | { err: PerpsError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: null } | { err: PerpsError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'PerpsV1',
      'Liquidate',
      position_id,
      'u64',
      'Result<Null, PerpsError>',
      this._program.programId,
    );
  }

  /**
   * Open an isolated-margin position. Escrows `margin` of the collateral token
   * (requires a prior `approve`); notional = margin * leverage at the mark.
   * 
   * Everything that can be checked before the escrow is checked before it. The two
   * post-await re-checks exist because the await yields to other messages, and
   * both credit the margin back before returning (audit C-03, M-08).
  */
  public openPosition(market_id: number | string | bigint, is_long: boolean, margin: number | string | bigint, leverage: number): TransactionBuilder<{ ok: number | string | bigint } | { err: PerpsError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: number | string | bigint } | { err: PerpsError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'PerpsV1',
      'OpenPosition',
      [market_id, is_long, margin, leverage],
      '(u64, bool, u128, u32)',
      'Result<u64, PerpsError>',
      this._program.programId,
    );
  }

  /**
   * Admin: set the collateral (settlement) token — the USDT VFT program.
  */
  public setCollateral(token: ActorId): TransactionBuilder<{ ok: null } | { err: PerpsError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: null } | { err: PerpsError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'PerpsV1',
      'SetCollateral',
      token,
      '[u8;32]',
      'Result<Null, PerpsError>',
      this._program.programId,
    );
  }

  /**
   * Admin: set the keeper account allowed to push mark prices. The zero address is
   * rejected — accepting it silently left admin as the sole mark authority
   * (audit L-04).
  */
  public setKeeper(keeper: ActorId): TransactionBuilder<{ ok: null } | { err: PerpsError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: null } | { err: PerpsError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'PerpsV1',
      'SetKeeper',
      keeper,
      '[u8;32]',
      'Result<Null, PerpsError>',
      this._program.programId,
    );
  }

  /**
   * Keeper: publish the mark price for a market.
   * 
   * Bounded to `MAX_MARK_DEVIATION_BPS` from the previous mark, so a compromised
   * keeper cannot reprice the book in a single transaction and liquidate it
   * (audit H-04). The bound is skipped only for the first mark, and once the feed
   * is stale past `MARK_EXIT_AGE` — by then positions can already exit at entry,
   * so a fresh start is not a lever over anyone.
  */
  public setMark(market_id: number | string | bigint, price: number | string | bigint): TransactionBuilder<{ ok: null } | { err: PerpsError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: null } | { err: PerpsError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'PerpsV1',
      'SetMark',
      [market_id, price],
      '(u64, u128)',
      'Result<Null, PerpsError>',
      this._program.programId,
    );
  }

  /**
   * Admin: cap open interest per side on a market.
  */
  public setMarketCap(market_id: number | string | bigint, max_oi: number | string | bigint): TransactionBuilder<{ ok: null } | { err: PerpsError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: null } | { err: PerpsError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'PerpsV1',
      'SetMarketCap',
      [market_id, max_oi],
      '(u64, u128)',
      'Result<Null, PerpsError>',
      this._program.programId,
    );
  }

  /**
   * Admin: withdraw reserve profit to the admin's claimable collateral.
   * 
   * Capped at the amount above current liability, so solvency is a contract
   * invariant instead of operator discipline — draining the reserve used to
   * silently truncate what winning traders received rather than failing loudly
   * (audit H-05).
  */
  public withdrawReserve(amount: number | string | bigint): TransactionBuilder<{ ok: number | string | bigint } | { err: PerpsError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: number | string | bigint } | { err: PerpsError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'PerpsV1',
      'WithdrawReserve',
      amount,
      'u128',
      'Result<u128, PerpsError>',
      this._program.programId,
    );
  }

  /**
   * `(collateral token, keeper)`. The collateral token is what margin is escrowed
   * in, so a client can attribute locked margin to the right token instead of
   * showing a wallet balance that silently dropped.
  */
  public getConfig(): QueryBuilder<[ActorId, ActorId]> {
    return new QueryBuilder<[ActorId, ActorId]>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'PerpsV1',
      'GetConfig',
      null,
      null,
      '([u8;32], [u8;32])',
    );
  }

  /**
   * Liquidation price for a position (0 if none).
  */
  public getLiqPrice(position_id: number | string | bigint): QueryBuilder<bigint> {
    return new QueryBuilder<bigint>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'PerpsV1',
      'GetLiqPrice',
      position_id,
      'u64',
      'u128',
    );
  }

  public getMarkets(): QueryBuilder<Array<PerpMarket>> {
    return new QueryBuilder<Array<PerpMarket>>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'PerpsV1',
      'GetMarkets',
      null,
      null,
      'Vec<PerpMarket>',
    );
  }

  /**
   * A trader's open positions with PnL at the current mark, paginated (audit L-05):
   * `(id, market_id, is_long, notional, entry, margin, leverage, pnl)`.
  */
  public getPositions(owner: ActorId, offset: number, limit: number): QueryBuilder<Array<[number | string | bigint, number | string | bigint, boolean, number | string | bigint, number | string | bigint, number | string | bigint, number, number | string | bigint]>> {
    return new QueryBuilder<Array<[number | string | bigint, number | string | bigint, boolean, number | string | bigint, number | string | bigint, number | string | bigint, number, number | string | bigint]>>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'PerpsV1',
      'GetPositions',
      [owner, offset, limit],
      '([u8;32], u32, u32)',
      'Vec<(u64, u64, bool, u128, u128, u128, u32, i128)>',
    );
  }

  public getReserve(): QueryBuilder<bigint> {
    return new QueryBuilder<bigint>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'PerpsV1',
      'GetReserve',
      null,
      null,
      'u128',
    );
  }

  /**
   * Reserve health: `(reserve, liability, coverage_bps)`. Surfaced so a trader can
   * see the reserve is thin *before* entering, rather than discovering it as a
   * truncated payout on the way out (audit M-04).
  */
  public getReserveHealth(): QueryBuilder<[number | string | bigint, number | string | bigint, number | string | bigint]> {
    return new QueryBuilder<[number | string | bigint, number | string | bigint, number | string | bigint]>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'PerpsV1',
      'GetReserveHealth',
      null,
      null,
      '(u128, u128, u128)',
    );
  }

  public subscribeToMarketAddedEvent(callback: (data: { market_id: number | string | bigint; symbol: string; max_oi: number | string | bigint }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'PerpsV1' && getFnNamePrefix(payload) === 'MarketAdded') {
        callback(this._program.registry.createType('(String, String, {"market_id":"u64","symbol":"String","max_oi":"u128"})', message.payload)[2].toJSON() as unknown as { market_id: number | string | bigint; symbol: string; max_oi: number | string | bigint });
      }
    });
  }

  public subscribeToMarketCapSetEvent(callback: (data: { market_id: number | string | bigint; max_oi: number | string | bigint }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'PerpsV1' && getFnNamePrefix(payload) === 'MarketCapSet') {
        callback(this._program.registry.createType('(String, String, {"market_id":"u64","max_oi":"u128"})', message.payload)[2].toJSON() as unknown as { market_id: number | string | bigint; max_oi: number | string | bigint });
      }
    });
  }

  public subscribeToMarkSetEvent(callback: (data: { market_id: number | string | bigint; price: number | string | bigint; block: number }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'PerpsV1' && getFnNamePrefix(payload) === 'MarkSet') {
        callback(this._program.registry.createType('(String, String, {"market_id":"u64","price":"u128","block":"u32"})', message.payload)[2].toJSON() as unknown as { market_id: number | string | bigint; price: number | string | bigint; block: number });
      }
    });
  }

  public subscribeToPositionOpenedEvent(callback: (data: { position_id: number | string | bigint; market_id: number | string | bigint; owner: ActorId; is_long: boolean; notional: number | string | bigint; entry: number | string | bigint; margin: number | string | bigint; leverage: number }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'PerpsV1' && getFnNamePrefix(payload) === 'PositionOpened') {
        callback(this._program.registry.createType('(String, String, {"position_id":"u64","market_id":"u64","owner":"[u8;32]","is_long":"bool","notional":"u128","entry":"u128","margin":"u128","leverage":"u32"})', message.payload)[2].toJSON() as unknown as { position_id: number | string | bigint; market_id: number | string | bigint; owner: ActorId; is_long: boolean; notional: number | string | bigint; entry: number | string | bigint; margin: number | string | bigint; leverage: number });
      }
    });
  }

  public subscribeToPositionClosedEvent(callback: (data: { position_id: number | string | bigint; owner: ActorId; payout: number | string | bigint; pnl: number | string | bigint; funding: number | string | bigint; at_entry: boolean }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'PerpsV1' && getFnNamePrefix(payload) === 'PositionClosed') {
        callback(this._program.registry.createType('(String, String, {"position_id":"u64","owner":"[u8;32]","payout":"u128","pnl":"i128","funding":"i128","at_entry":"bool"})', message.payload)[2].toJSON() as unknown as { position_id: number | string | bigint; owner: ActorId; payout: number | string | bigint; pnl: number | string | bigint; funding: number | string | bigint; at_entry: boolean });
      }
    });
  }

  public subscribeToPositionLiquidatedEvent(callback: (data: { position_id: number | string | bigint; owner: ActorId; liquidator: ActorId; to_owner: number | string | bigint; fee: number | string | bigint }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'PerpsV1' && getFnNamePrefix(payload) === 'PositionLiquidated') {
        callback(this._program.registry.createType('(String, String, {"position_id":"u64","owner":"[u8;32]","liquidator":"[u8;32]","to_owner":"u128","fee":"u128"})', message.payload)[2].toJSON() as unknown as { position_id: number | string | bigint; owner: ActorId; liquidator: ActorId; to_owner: number | string | bigint; fee: number | string | bigint });
      }
    });
  }

  public subscribeToReserveFundedEvent(callback: (data: { amount: number | string | bigint; reserve: number | string | bigint }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'PerpsV1' && getFnNamePrefix(payload) === 'ReserveFunded') {
        callback(this._program.registry.createType('(String, String, {"amount":"u128","reserve":"u128"})', message.payload)[2].toJSON() as unknown as { amount: number | string | bigint; reserve: number | string | bigint });
      }
    });
  }

  public subscribeToReserveWithdrawnEvent(callback: (data: { amount: number | string | bigint; reserve: number | string | bigint }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'PerpsV1' && getFnNamePrefix(payload) === 'ReserveWithdrawn') {
        callback(this._program.registry.createType('(String, String, {"amount":"u128","reserve":"u128"})', message.payload)[2].toJSON() as unknown as { amount: number | string | bigint; reserve: number | string | bigint });
      }
    });
  }

  public subscribeToKeeperSetEvent(callback: (data: { keeper: ActorId }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'PerpsV1' && getFnNamePrefix(payload) === 'KeeperSet') {
        callback(this._program.registry.createType('(String, String, {"keeper":"[u8;32]"})', message.payload)[2].toJSON() as unknown as { keeper: ActorId });
      }
    });
  }

  public subscribeToCollateralSetEvent(callback: (data: { token: ActorId }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'PerpsV1' && getFnNamePrefix(payload) === 'CollateralSet') {
        callback(this._program.registry.createType('(String, String, {"token":"[u8;32]"})', message.payload)[2].toJSON() as unknown as { token: ActorId });
      }
    });
  }
}