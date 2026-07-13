/* eslint-disable */

import { GearApi, BaseGearProgram } from '@gear-js/api';
import { TypeRegistry } from '@polkadot/types';
import { TransactionBuilder, QueryBuilder, getServiceNamePrefix, getFnNamePrefix, ZERO_ADDRESS } from 'sails-js';
import type { ActorId } from 'sails-js';

export class SailsProgram {
  public readonly registry: TypeRegistry;
  public readonly orderbook: Orderbook;
  public readonly amm: Amm;
  private _program?: BaseGearProgram;

  constructor(public api: GearApi, programId?: `0x${string}`) {
    const types: Record<string, any> = {
      ContractError: {"_enum":["NotAuthorized","NotAdmin","BadParams","JoinFirst","InsufficientUsd","InsufficientAsset","OrderNotFound","OrderAlreadyDone","NoLiquidity","NoBuyers","PoolExists","PoolNotFound","SameAssetPool","InsufficientLiquidity","SlippageExceeded","ZeroAmount","AgentCallFailed"]},
      PriceFeed: {"symbol":"String","price_usd_micro":"u64","change_24h_bps":"i32","market_cap_usd":"u64","volume_24h_usd":"u64","updated_at_block":"u32"},
      Asset: {"_enum":["BTC","ETH","VARA"]},
      Side: {"_enum":["Buy","Sell"]},
      AgentStrategy: {"_enum":["ArbitrageHunter","MarketMaker","Momentum"]},
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
    }

    this.registry = new TypeRegistry();
    this.registry.setKnownTypes({ types });
    this.registry.register(types);
    if (programId) {
      this._program = new BaseGearProgram(programId, api);
    }

    this.orderbook = new Orderbook(this);
    this.amm = new Amm(this);
  }

  public get programId(): `0x${string}` {
    if (!this._program) throw new Error(`Program ID is not set`);
    return this._program.id;
  }

  newCtorFromCode(code: Uint8Array): TransactionBuilder<null> {
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

  public challenge(opponent: ActorId, amount: number | string | bigint): TransactionBuilder<{ ok: number } | { err: ContractError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: number } | { err: ContractError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Orderbook',
      'Challenge',
      [opponent, amount],
      '([u8;32], u64)',
      'Result<u32, ContractError>',
      this._program.programId,
    );
  }

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

  public pushOracleData(oracle: ActorId, data: number | string | bigint): TransactionBuilder<null> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<null>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Orderbook',
      'PushOracleData',
      [oracle, data],
      '([u8;32], u64)',
      'Null',
      this._program.programId,
    );
  }

  public signalCollab(partner: ActorId, _note: string): TransactionBuilder<null> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<null>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Orderbook',
      'SignalCollab',
      [partner, _note],
      '([u8;32], String)',
      'Null',
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

  public subscribeOracle(oracle: ActorId, label: string): TransactionBuilder<null> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<null>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Orderbook',
      'SubscribeOracle',
      [oracle, label],
      '([u8;32], String)',
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

  public getStatus(): QueryBuilder<[number, number | string | bigint, number, boolean, number, number]> {
    return new QueryBuilder<[number, number | string | bigint, number, boolean, number, number]>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Orderbook',
      'GetStatus',
      null,
      null,
      '(u32, u64, u32, bool, u32, u32)',
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
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {
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
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {
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
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {
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
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {
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
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {
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
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {
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
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {
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