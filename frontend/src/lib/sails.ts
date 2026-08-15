/* eslint-disable */

import { GearApi, BaseGearProgram } from '@gear-js/api';
import type { HexString } from '@gear-js/api';
import { TypeRegistry } from '@polkadot/types';
import { TransactionBuilder, ActorId, QueryBuilder, getServiceNamePrefix, getFnNamePrefix, ZERO_ADDRESS } from 'sails-js';

export class SailsProgram {
  public readonly registry: TypeRegistry;
  public readonly orderbook: Orderbook;
  public readonly amm: Amm;
  public readonly perps: Perps;
  public readonly spot: Spot;
  public readonly perpsV1: PerpsV1;
  private _program?: BaseGearProgram;

  constructor(public api: GearApi, programId?: `0x${string}`) {
    const types: Record<string, any> = {
      ContractError: {"_enum":["NotAuthorized","NotAdmin","BadParams","JoinFirst","InsufficientUsd","InsufficientAsset","OrderNotFound","OrderAlreadyDone","NoLiquidity","NoBuyers","PoolExists","PoolNotFound","SameAssetPool","InsufficientLiquidity","SlippageExceeded","ZeroAmount","AgentCallFailed","BookFull","NoMarkPrice","LeverageTooHigh","PositionNotFound","WrongDirection","NotLiquidatable","StaleMark"]},
      TokenKind: {"_enum":["Usd","Btc","Eth","Vara"]},
      AgentStrategy: {"_enum":["ArbitrageHunter","MarketMaker","Momentum"]},
      Asset: {"_enum":["BTC","ETH","VARA"]},
      Side: {"_enum":["Buy","Sell"]},
      LeaderEntry: {"id":"[u8;32]","name":"String","strategy":"AgentStrategy","usd":"u64","net_worth":"u64"},
      OrderStatus: {"_enum":["Open","Partial","Filled","Cancelled"]},
      OrderPlacedEvent: {"trader":"[u8;32]","side":"Side","asset":"Asset","price":"u64","qty":"u64","order_id":"u64"},
      OrderCancelledEvent: {"trader":"[u8;32]","order_id":"u64"},
      TradeEvent: {"trade_id":"u64","asset":"Asset","price":"u64","qty":"u64","buyer":"[u8;32]","seller":"[u8;32]"},
      LpPosition: {"pool_id":"u64","provider":"[u8;32]","amount":"u64","share_a":"u64","share_b":"u64"},
      Pool: {"id":"u64","asset_a":"Asset","asset_b":"Asset","reserve_a":"u64","reserve_b":"u64","total_lp":"u64","creator":"[u8;32]"},
      PoolCreatedEvent: {"pool_id":"u64","asset_a":"Asset","asset_b":"Asset","creator":"[u8;32]"},
      LiquidityAddedEvent: {"pool_id":"u64","provider":"[u8;32]","amount_a":"u64","amount_b":"u64","lp_minted":"u64"},
      LiquidityRemovedEvent: {"pool_id":"u64","provider":"[u8;32]","amount_a":"u64","amount_b":"u64","lp_burned":"u64"},
      SwapExecutedEvent: {"pool_id":"u64","trader":"[u8;32]","asset_in":"Asset","amount_in":"u64","asset_out":"Asset","amount_out":"u64","fee":"u64"},
      MarkPriceEvent: {"asset":"Asset","price":"u64"},
      PerpOpenedEvent: {"owner":"[u8;32]","asset":"Asset","is_long":"bool","size":"u64","entry":"u64","margin":"u64","leverage":"u32"},
      PerpClosedEvent: {"owner":"[u8;32]","asset":"Asset","exit":"u64","payout":"u64","pnl":"i64","liquidated":"bool"},
      SpotError: {"_enum":["NotAdmin","BadParams","PairExists","NoPair","PairInactive","BookFull","NoOrder","NotOwner","NothingToClaim","TransferFailed"]},
      SpotOrder: {"id":"u64","pair_id":"u64","trader":"[u8;32]","side":"Side","price":"u128","qty":"u128","filled":"u128","status":"SpotStatus"},
      SpotStatus: {"_enum":["Open","PartiallyFilled","Filled","Cancelled"]},
      SpotPair: {"id":"u64","base":"[u8;32]","quote":"[u8;32]","base_dec":"u8","quote_dec":"u8","active":"bool"},
      PerpsError: {"_enum":["NotAdmin","NotKeeper","BadParams","NoMarket","MarketInactive","StaleMark","LeverageTooHigh","InsufficientMargin","PositionNotFound","NotLiquidatable","BookFull","TransferFailed","NoCollateral","OiCapExceeded"]},
      PerpMarket: {"id":"u64","symbol":"String","mark":"u128","mark_block":"u32","active":"bool","long_oi":"u128","short_oi":"u128","max_oi":"u128"},
    }

    this.registry = new TypeRegistry();
    this.registry.setKnownTypes({ types });
    this.registry.register(types);
    if (programId) {
      this._program = new BaseGearProgram(programId, api);
    }

    this.orderbook = new Orderbook(this);
    this.amm = new Amm(this);
    this.perps = new Perps(this);
    this.spot = new Spot(this);
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

export class Orderbook {
  constructor(private _program: SailsProgram) {}

  public callAgentService(target: ActorId, payload: `0x${string}`, gas_limit: number | string | bigint): TransactionBuilder<{ ok: `0x${string}` } | { err: ContractError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: `0x${string}` } | { err: ContractError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Orderbook',
      'CallAgentService',
      [target, payload, gas_limit],
      '([u8;32], Vec<u8>, u64)',
      'Result<Vec<u8>, ContractError>',
      this._program.programId,
    );
  }

  public cancelOrder(oid: number | string | bigint): TransactionBuilder<{ ok: null } | { err: ContractError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: null } | { err: ContractError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Orderbook',
      'CancelOrder',
      oid,
      'u64',
      'Result<Null, ContractError>',
      this._program.programId,
    );
  }

  /**
   * Move real VFT tokens from the caller into the DEX vault, crediting their
   * internal balance. The caller must have `approve`d the DEX on the token
   * program for at least `amount` first. Credits only after the on-chain
   * transfer succeeds, so the internal balance stays fully token-backed.
  */
  public deposit(kind: TokenKind, amount: number | string | bigint): TransactionBuilder<{ ok: number | string | bigint } | { err: ContractError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: number | string | bigint } | { err: ContractError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Orderbook',
      'Deposit',
      [kind, amount],
      '(TokenKind, u64)',
      'Result<u64, ContractError>',
      this._program.programId,
    );
  }

  /**
   * Register the caller's agent identity (name + strategy) and grant the
   * starting balances. This is the virtual-balance model: an agent is funded
   * the instant it joins, so it can trade immediately with no token custody,
   * approve, or deposit step. Idempotent: re-joining returns the existing
   * balances and keeps the original identity (no double funding).
  */
  public join(name: string, strategy: AgentStrategy): TransactionBuilder<[number | string | bigint, number | string | bigint, number | string | bigint, number | string | bigint]> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<[number | string | bigint, number | string | bigint, number | string | bigint, number | string | bigint]>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Orderbook',
      'Join',
      [name, strategy],
      '(String, AgentStrategy)',
      '(u64, u64, u64, u64)',
      this._program.programId,
    );
  }

  public marketBuy(asset: Asset, qty: number | string | bigint): TransactionBuilder<{ ok: string } | { err: ContractError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: string } | { err: ContractError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Orderbook',
      'MarketBuy',
      [asset, qty],
      '(Asset, u64)',
      'Result<String, ContractError>',
      this._program.programId,
    );
  }

  public marketSell(asset: Asset, qty: number | string | bigint): TransactionBuilder<{ ok: string } | { err: ContractError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: string } | { err: ContractError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Orderbook',
      'MarketSell',
      [asset, qty],
      '(Asset, u64)',
      'Result<String, ContractError>',
      this._program.programId,
    );
  }

  public placeLimit(side: Side, asset: Asset, price: number | string | bigint, qty: number | string | bigint): TransactionBuilder<{ ok: number | string | bigint } | { err: ContractError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: number | string | bigint } | { err: ContractError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Orderbook',
      'PlaceLimit',
      [side, asset, price, qty],
      '(Side, Asset, u64, u64)',
      'Result<u64, ContractError>',
      this._program.programId,
    );
  }

  /**
   * Admin-only, one-time: grant the house (admin) a deep USDT + asset stockpile
   * so the market maker can quote both sides and USDT-only agents always have a
   * counterparty. Idempotent — after the first call it just returns the balances.
  */
  public seedHouse(): TransactionBuilder<{ ok: [number | string | bigint, number | string | bigint, number | string | bigint, number | string | bigint] } | { err: ContractError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: [number | string | bigint, number | string | bigint, number | string | bigint, number | string | bigint] } | { err: ContractError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Orderbook',
      'SeedHouse',
      null,
      null,
      'Result<(u64, u64, u64, u64), ContractError>',
      this._program.programId,
    );
  }

  /**
   * Admin-only: register the VFT program ID that backs a custodied balance.
   * Must be set before deposit/withdraw can move real tokens for that kind.
  */
  public setToken(kind: TokenKind, address: ActorId): TransactionBuilder<{ ok: null } | { err: ContractError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: null } | { err: ContractError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Orderbook',
      'SetToken',
      [kind, address],
      '(TokenKind, [u8;32])',
      'Result<Null, ContractError>',
      this._program.programId,
    );
  }

  public startAutopilot(): TransactionBuilder<null> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<null>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Orderbook',
      'StartAutopilot',
      null,
      null,
      'Null',
      this._program.programId,
    );
  }

  public tick(): TransactionBuilder<{ ok: string } | { err: ContractError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: string } | { err: ContractError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Orderbook',
      'Tick',
      null,
      null,
      'Result<String, ContractError>',
      this._program.programId,
    );
  }

  /**
   * Withdraw real VFT tokens from the DEX vault back to the caller. Debits the
   * internal balance first, then transfers on-chain; if the transfer fails the
   * debit is reverted so funds are never silently lost.
  */
  public withdraw(kind: TokenKind, amount: number | string | bigint): TransactionBuilder<{ ok: number | string | bigint } | { err: ContractError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: number | string | bigint } | { err: ContractError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Orderbook',
      'Withdraw',
      [kind, amount],
      '(TokenKind, u64)',
      'Result<u64, ContractError>',
      this._program.programId,
    );
  }

  /**
   * Caller's agent identity, or None if they haven't joined. Used by the UI to
   * decide whether to show the "Create your Agent" onboarding.
  */
  public getIdentity(): QueryBuilder<[string, AgentStrategy] | null> {
    return new QueryBuilder<[string, AgentStrategy] | null>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Orderbook',
      'GetIdentity',
      null,
      null,
      'Option<(String, AgentStrategy)>',
    );
  }

  public getLeaderboard(limit: number): QueryBuilder<Array<LeaderEntry>> {
    return new QueryBuilder<Array<LeaderEntry>>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Orderbook',
      'GetLeaderboard',
      limit,
      'u32',
      'Vec<LeaderEntry>',
    );
  }

  public getMyOrders(): QueryBuilder<Array<[number | string | bigint, Side, Asset, number | string | bigint, number | string | bigint, number | string | bigint, OrderStatus]>> {
    return new QueryBuilder<Array<[number | string | bigint, Side, Asset, number | string | bigint, number | string | bigint, number | string | bigint, OrderStatus]>>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Orderbook',
      'GetMyOrders',
      null,
      null,
      'Vec<(u64, Side, Asset, u64, u64, u64, OrderStatus)>',
    );
  }

  public getOrderbook(asset: Asset): QueryBuilder<[Array<[number | string | bigint, number | string | bigint]>, Array<[number | string | bigint, number | string | bigint]>]> {
    return new QueryBuilder<[Array<[number | string | bigint, number | string | bigint]>, Array<[number | string | bigint, number | string | bigint]>]>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Orderbook',
      'GetOrderbook',
      asset,
      'Asset',
      '(Vec<(u64, u64)>, Vec<(u64, u64)>)',
    );
  }

  public getPortfolio(): QueryBuilder<[number | string | bigint, number | string | bigint, number | string | bigint, number | string | bigint]> {
    return new QueryBuilder<[number | string | bigint, number | string | bigint, number | string | bigint, number | string | bigint]>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Orderbook',
      'GetPortfolio',
      null,
      null,
      '(u64, u64, u64, u64)',
    );
  }

  public getStatus(): QueryBuilder<[number, number | string | bigint, number, boolean, number]> {
    return new QueryBuilder<[number, number | string | bigint, number, boolean, number]>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Orderbook',
      'GetStatus',
      null,
      null,
      '(u32, u64, u32, bool, u32)',
    );
  }

  public getToken(kind: TokenKind): QueryBuilder<ActorId> {
    return new QueryBuilder<ActorId>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Orderbook',
      'GetToken',
      kind,
      'TokenKind',
      '[u8;32]',
    );
  }

  /**
   * All four token registrations as (usd, btc, eth, vara) for the UI/agents.
  */
  public getTokens(): QueryBuilder<[ActorId, ActorId, ActorId, ActorId]> {
    return new QueryBuilder<[ActorId, ActorId, ActorId, ActorId]>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Orderbook',
      'GetTokens',
      null,
      null,
      '([u8;32], [u8;32], [u8;32], [u8;32])',
    );
  }

  public getTrades(asset: Asset, limit: number): QueryBuilder<Array<[number | string | bigint, number | string | bigint, number | string | bigint, ActorId, ActorId]>> {
    return new QueryBuilder<Array<[number | string | bigint, number | string | bigint, number | string | bigint, ActorId, ActorId]>>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Orderbook',
      'GetTrades',
      [asset, limit],
      '(Asset, u32)',
      'Vec<(u64, u64, u64, [u8;32], [u8;32])>',
    );
  }

  public subscribeToOrderPlacedEvent(callback: (data: OrderPlacedEvent) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Orderbook' && getFnNamePrefix(payload) === 'OrderPlaced') {
        callback(this._program.registry.createType('(String, String, OrderPlacedEvent)', message.payload)[2].toJSON() as unknown as OrderPlacedEvent);
      }
    });
  }

  public subscribeToOrderCancelledEvent(callback: (data: OrderCancelledEvent) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Orderbook' && getFnNamePrefix(payload) === 'OrderCancelled') {
        callback(this._program.registry.createType('(String, String, OrderCancelledEvent)', message.payload)[2].toJSON() as unknown as OrderCancelledEvent);
      }
    });
  }

  public subscribeToTradeEvent(callback: (data: TradeEvent) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Orderbook' && getFnNamePrefix(payload) === 'Trade') {
        callback(this._program.registry.createType('(String, String, TradeEvent)', message.payload)[2].toJSON() as unknown as TradeEvent);
      }
    });
  }
}

export class Amm {
  constructor(private _program: SailsProgram) {}

  public addLiquidity(pool_id: number | string | bigint, amount_a: number | string | bigint, amount_b: number | string | bigint): TransactionBuilder<{ ok: number | string | bigint } | { err: ContractError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: number | string | bigint } | { err: ContractError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Amm',
      'AddLiquidity',
      [pool_id, amount_a, amount_b],
      '(u64, u64, u64)',
      'Result<u64, ContractError>',
      this._program.programId,
    );
  }

  public createPool(asset_a: Asset, asset_b: Asset): TransactionBuilder<{ ok: number | string | bigint } | { err: ContractError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: number | string | bigint } | { err: ContractError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Amm',
      'CreatePool',
      [asset_a, asset_b],
      '(Asset, Asset)',
      'Result<u64, ContractError>',
      this._program.programId,
    );
  }

  public removeLiquidity(pool_id: number | string | bigint, lp_amount: number | string | bigint): TransactionBuilder<{ ok: [number | string | bigint, number | string | bigint] } | { err: ContractError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: [number | string | bigint, number | string | bigint] } | { err: ContractError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Amm',
      'RemoveLiquidity',
      [pool_id, lp_amount],
      '(u64, u64)',
      'Result<(u64, u64), ContractError>',
      this._program.programId,
    );
  }

  public swap(pool_id: number | string | bigint, asset_in: Asset, amount_in: number | string | bigint, min_amount_out: number | string | bigint): TransactionBuilder<{ ok: number | string | bigint } | { err: ContractError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: number | string | bigint } | { err: ContractError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Amm',
      'Swap',
      [pool_id, asset_in, amount_in, min_amount_out],
      '(u64, Asset, u64, u64)',
      'Result<u64, ContractError>',
      this._program.programId,
    );
  }

  public getLpPosition(pool_id: number | string | bigint, provider: ActorId): QueryBuilder<LpPosition | null> {
    return new QueryBuilder<LpPosition | null>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Amm',
      'GetLpPosition',
      [pool_id, provider],
      '(u64, [u8;32])',
      'Option<LpPosition>',
    );
  }

  public getPool(pool_id: number | string | bigint): QueryBuilder<Pool | null> {
    return new QueryBuilder<Pool | null>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Amm',
      'GetPool',
      pool_id,
      'u64',
      'Option<Pool>',
    );
  }

  public listPools(): QueryBuilder<Array<Pool>> {
    return new QueryBuilder<Array<Pool>>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Amm',
      'ListPools',
      null,
      null,
      'Vec<Pool>',
    );
  }

  public subscribeToPoolCreatedEvent(callback: (data: PoolCreatedEvent) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Amm' && getFnNamePrefix(payload) === 'PoolCreated') {
        callback(this._program.registry.createType('(String, String, PoolCreatedEvent)', message.payload)[2].toJSON() as unknown as PoolCreatedEvent);
      }
    });
  }

  public subscribeToLiquidityAddedEvent(callback: (data: LiquidityAddedEvent) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Amm' && getFnNamePrefix(payload) === 'LiquidityAdded') {
        callback(this._program.registry.createType('(String, String, LiquidityAddedEvent)', message.payload)[2].toJSON() as unknown as LiquidityAddedEvent);
      }
    });
  }

  public subscribeToLiquidityRemovedEvent(callback: (data: LiquidityRemovedEvent) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Amm' && getFnNamePrefix(payload) === 'LiquidityRemoved') {
        callback(this._program.registry.createType('(String, String, LiquidityRemovedEvent)', message.payload)[2].toJSON() as unknown as LiquidityRemovedEvent);
      }
    });
  }

  public subscribeToSwapExecutedEvent(callback: (data: SwapExecutedEvent) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Amm' && getFnNamePrefix(payload) === 'SwapExecuted') {
        callback(this._program.registry.createType('(String, String, SwapExecutedEvent)', message.payload)[2].toJSON() as unknown as SwapExecutedEvent);
      }
    });
  }
}

export class Perps {
  constructor(private _program: SailsProgram) {}

  /**
   * Close your whole position at the current mark price, settling PnL against the
   * house reserve. Returns `(payout_cents, pnl_cents_signed)`.
  */
  public closePosition(asset: Asset): TransactionBuilder<{ ok: [number | string | bigint, number | string | bigint] } | { err: ContractError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: [number | string | bigint, number | string | bigint] } | { err: ContractError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Perps',
      'ClosePosition',
      asset,
      'Asset',
      'Result<(u64, i64), ContractError>',
      this._program.programId,
    );
  }

  /**
   * Admin: move USD (cents) from your own balance into the house reserve that
   * pays trader profits. Never mints — total custodied USD is unchanged.
  */
  public fundReserve(amount: number | string | bigint): TransactionBuilder<{ ok: number | string | bigint } | { err: ContractError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: number | string | bigint } | { err: ContractError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Perps',
      'FundReserve',
      amount,
      'u64',
      'Result<u64, ContractError>',
      this._program.programId,
    );
  }

  /**
   * Permissionless liquidation: if a position's equity has fallen to the
   * maintenance margin, anyone may close it at the mark. The liquidator earns a
   * small fee from the residual equity; the rest flows to the reserve.
  */
  public liquidate(owner: ActorId, asset: Asset): TransactionBuilder<{ ok: null } | { err: ContractError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: null } | { err: ContractError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Perps',
      'Liquidate',
      [owner, asset],
      '([u8;32], Asset)',
      'Result<Null, ContractError>',
      this._program.programId,
    );
  }

  /**
   * Open (or add to) an isolated-margin perpetual position. Locks `margin` USD
   * cents from your balance; position size = margin * leverage at the mark price.
  */
  public openPosition(asset: Asset, is_long: boolean, margin: number | string | bigint, leverage: number): TransactionBuilder<{ ok: number | string | bigint } | { err: ContractError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: number | string | bigint } | { err: ContractError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Perps',
      'OpenPosition',
      [asset, is_long, margin, leverage],
      '(Asset, bool, u64, u32)',
      'Result<u64, ContractError>',
      this._program.programId,
    );
  }

  /**
   * Keeper-only: publish the mark price (USD cents) for an asset. This is the
   * price PnL and liquidations settle at — like GMX/Pyth keepers pushing a feed.
  */
  public setMarkPrice(asset: Asset, price: number | string | bigint): TransactionBuilder<{ ok: null } | { err: ContractError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: null } | { err: ContractError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Perps',
      'SetMarkPrice',
      [asset, price],
      '(Asset, u64)',
      'Result<Null, ContractError>',
      this._program.programId,
    );
  }

  /**
   * Keeper convenience: push all three marks at once (BTC, ETH, VARA), each in
   * USD cents. A zero leaves that asset's mark unchanged.
  */
  public setMarkPrices(btc: number | string | bigint, eth: number | string | bigint, vara: number | string | bigint): TransactionBuilder<{ ok: null } | { err: ContractError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: null } | { err: ContractError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Perps',
      'SetMarkPrices',
      [btc, eth, vara],
      '(u64, u64, u64)',
      'Result<Null, ContractError>',
      this._program.programId,
    );
  }

  /**
   * Liquidation price (USD cents) for a position, i.e. the mark at which equity
   * hits maintenance margin. 0 if there is no such position.
  */
  public getLiqPrice(owner: ActorId, asset: Asset): QueryBuilder<bigint> {
    return new QueryBuilder<bigint>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Perps',
      'GetLiqPrice',
      [owner, asset],
      '([u8;32], Asset)',
      'u64',
    );
  }

  public getMarkPrice(asset: Asset): QueryBuilder<bigint> {
    return new QueryBuilder<bigint>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Perps',
      'GetMarkPrice',
      asset,
      'Asset',
      'u64',
    );
  }

  public getMarkPrices(): QueryBuilder<[number | string | bigint, number | string | bigint, number | string | bigint]> {
    return new QueryBuilder<[number | string | bigint, number | string | bigint, number | string | bigint]>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Perps',
      'GetMarkPrices',
      null,
      null,
      '(u64, u64, u64)',
    );
  }

  /**
   * A trader's open positions as
   * `(asset, is_long, size, entry, margin, leverage, pnl_at_mark)`.
  */
  public getPositions(owner: ActorId): QueryBuilder<Array<[Asset, boolean, number | string | bigint, number | string | bigint, number | string | bigint, number, number | string | bigint]>> {
    return new QueryBuilder<Array<[Asset, boolean, number | string | bigint, number | string | bigint, number | string | bigint, number, number | string | bigint]>>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Perps',
      'GetPositions',
      owner,
      '[u8;32]',
      'Vec<(Asset, bool, u64, u64, u64, u32, i64)>',
    );
  }

  public getReserve(): QueryBuilder<bigint> {
    return new QueryBuilder<bigint>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Perps',
      'GetReserve',
      null,
      null,
      'u64',
    );
  }

  public subscribeToMarkPriceEvent(callback: (data: MarkPriceEvent) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Perps' && getFnNamePrefix(payload) === 'MarkPrice') {
        callback(this._program.registry.createType('(String, String, MarkPriceEvent)', message.payload)[2].toJSON() as unknown as MarkPriceEvent);
      }
    });
  }

  public subscribeToOpenedEvent(callback: (data: PerpOpenedEvent) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Perps' && getFnNamePrefix(payload) === 'Opened') {
        callback(this._program.registry.createType('(String, String, PerpOpenedEvent)', message.payload)[2].toJSON() as unknown as PerpOpenedEvent);
      }
    });
  }

  public subscribeToClosedEvent(callback: (data: PerpClosedEvent) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Perps' && getFnNamePrefix(payload) === 'Closed') {
        callback(this._program.registry.createType('(String, String, PerpClosedEvent)', message.payload)[2].toJSON() as unknown as PerpClosedEvent);
      }
    });
  }
}

export class Spot {
  constructor(private _program: SailsProgram) {}

  /**
   * Cancel an open order and refund its unfilled escrow to the caller's claimable
   * balance (quote for a buy, base for a sell).
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
   * proceeds withdrawn. Admin-only.
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
   * Curate a new TOKEN/quote market. Admin-only (multisig on mainnet). `base_dec`
   * and `quote_dec` are the tokens' declared decimals; the caller supplies them so
   * listing stays synchronous (they are verifiable against each VFT's metadata).
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
   * Market buy up to `qty` base, spending at most `max_quote` quote tokens. Escrows
   * the full budget up front, sweeps the asks cheapest-first, and refunds anything
   * unspent (including the whole budget if the book is empty) to the caller's claim.
   * Never rests. Requires a prior `approve` of `max_quote` on the quote token.
  */
  public marketBuy(pair_id: number | string | bigint, qty: number | string | bigint, max_quote: number | string | bigint): TransactionBuilder<{ ok: number | string | bigint } | { err: SpotError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: number | string | bigint } | { err: SpotError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Spot',
      'MarketBuy',
      [pair_id, qty, max_quote],
      '(u64, u128, u128)',
      'Result<u64, SpotError>',
      this._program.programId,
    );
  }

  /**
   * Market sell `qty` base into the bids, highest-first. Escrows the base up front,
   * credits quote proceeds, and refunds any unfilled base to the caller's claim.
   * Never rests. Requires a prior `approve` of `qty` on the base token.
  */
  public marketSell(pair_id: number | string | bigint, qty: number | string | bigint): TransactionBuilder<{ ok: number | string | bigint } | { err: SpotError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: number | string | bigint } | { err: SpotError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Spot',
      'MarketSell',
      [pair_id, qty],
      '(u64, u128)',
      'Result<u64, SpotError>',
      this._program.programId,
    );
  }

  /**
   * Place a limit order. Escrows the caller's real tokens (a quote-token
   * `TransferFrom` for a buy, base-token for a sell — requires a prior `approve`),
   * then crosses the book by price-time priority, crediting fills to claimable
   * balances. Any unfilled remainder rests. Reverts with no state change if the
   * escrow transfer fails.
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
   * Hand listing/admin authority to a new account (the multisig on mainnet).
   * Admin-only; irreversible except by the new admin.
  */
  public transferAdmin(new_admin: ActorId): TransactionBuilder<{ ok: null } | { err: SpotError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: null } | { err: SpotError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Spot',
      'TransferAdmin',
      new_admin,
      '[u8;32]',
      'Result<Null, SpotError>',
      this._program.programId,
    );
  }

  /**
   * Withdraw the caller's full claimable balance of `token` to their wallet. Debits
   * optimistically and restores the claim if the on-chain transfer fails.
  */
  public withdraw(token: ActorId): TransactionBuilder<{ ok: number | string | bigint } | { err: SpotError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: number | string | bigint } | { err: SpotError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Spot',
      'Withdraw',
      token,
      '[u8;32]',
      'Result<u128, SpotError>',
      this._program.programId,
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
   * The caller's open/closed orders.
  */
  public getMyOrders(): QueryBuilder<Array<SpotOrder>> {
    return new QueryBuilder<Array<SpotOrder>>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Spot',
      'GetMyOrders',
      null,
      null,
      'Vec<SpotOrder>',
    );
  }

  /**
   * Aggregated resting depth for a pair: (bids desc by price, asks asc by price),
   * each level `(price, remaining_qty)`.
  */
  public getOrderbook(pair_id: number | string | bigint): QueryBuilder<[Array<[number | string | bigint, number | string | bigint]>, Array<[number | string | bigint, number | string | bigint]>]> {
    return new QueryBuilder<[Array<[number | string | bigint, number | string | bigint]>, Array<[number | string | bigint, number | string | bigint]>]>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Spot',
      'GetOrderbook',
      pair_id,
      'u64',
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

  public getPairs(): QueryBuilder<Array<SpotPair>> {
    return new QueryBuilder<Array<SpotPair>>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Spot',
      'GetPairs',
      null,
      null,
      'Vec<SpotPair>',
    );
  }
}

export class PerpsV1 {
  constructor(private _program: SailsProgram) {}

  /**
   * Admin: list a perp market by symbol. Returns its id.
  */
  public addMarket($symbol: string): TransactionBuilder<{ ok: number | string | bigint } | { err: PerpsError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: number | string | bigint } | { err: PerpsError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'PerpsV1',
      'AddMarket',
      $symbol,
      'String',
      'Result<u64, PerpsError>',
      this._program.programId,
    );
  }

  /**
   * Close your position at the current mark, settling PnL against the reserve and
   * crediting the payout to your claimable collateral (withdraw via `Spot/Withdraw`).
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
   * Permissionless liquidation once equity falls to maintenance margin. The
   * liquidator earns a fee from residual equity; the rest is settled to the owner.
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
   * Admin: set the keeper account allowed to push mark prices.
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
   * Admin: cap open interest per side on a market, bounding the reserve's max loss.
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
   * Admin: withdraw reserve profit (fees + net trader losses) to the admin's
   * claimable collateral. The operator is responsible for leaving enough to cover
   * open positions — withdraw profit, not the whole book.
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
   * A trader's open positions with PnL at the current mark:
   * `(id, market_id, is_long, notional, entry, margin, leverage, pnl)`.
  */
  public getPositions(owner: ActorId): QueryBuilder<Array<[number | string | bigint, number | string | bigint, boolean, number | string | bigint, number | string | bigint, number | string | bigint, number, number | string | bigint]>> {
    return new QueryBuilder<Array<[number | string | bigint, number | string | bigint, boolean, number | string | bigint, number | string | bigint, number | string | bigint, number, number | string | bigint]>>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'PerpsV1',
      'GetPositions',
      owner,
      '[u8;32]',
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
}