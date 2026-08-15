/* eslint-disable */

import { GearApi, BaseGearProgram } from '@gear-js/api';
import type { HexString } from '@gear-js/api';
import { TypeRegistry } from '@polkadot/types';
import { TransactionBuilder, ActorId, QueryBuilder, getServiceNamePrefix, getFnNamePrefix, ZERO_ADDRESS } from 'sails-js';

export class VftProgram {
  public readonly registry: TypeRegistry;
  public readonly vft: Vft;
  public readonly vftAdmin: VftAdmin;
  public readonly vftMetadata: VftMetadata;
  public readonly accessControl: AccessControl;
  public readonly faucet: Faucet;
  private _program?: BaseGearProgram;

  constructor(public api: GearApi, programId?: `0x${string}`) {
    const types: Record<string, any> = {
      Pagination: {"offset":"u32","limit":"u32"},
      FaucetError: {"_enum":["AlreadyClaimed","MintFailed"]},
    }

    this.registry = new TypeRegistry();
    this.registry.setKnownTypes({ types });
    this.registry.register(types);
    if (programId) {
      this._program = new BaseGearProgram(programId, api);
    }

    this.vft = new Vft(this);
    this.vftAdmin = new VftAdmin(this);
    this.vftMetadata = new VftMetadata(this);
    this.accessControl = new AccessControl(this);
    this.faucet = new Faucet(this);
  }

  public get programId(): `0x${string}` {
    if (!this._program) throw new Error(`Program ID is not set`);
    return this._program.id;
  }

  /**
   * Deploy a token with the given metadata and per-account faucet amount. The
   * deployer becomes the initial access-control admin (can grant minter roles).
  */
  newCtorFromCode(code: Uint8Array | Buffer | HexString, name: string, $symbol: string, decimals: number, faucet_amount: number | string | bigint): TransactionBuilder<null> {
    const builder = new TransactionBuilder<null>(
      this.api,
      this.registry,
      'upload_program',
      null,
      'New',
      [name, $symbol, decimals, faucet_amount],
      '(String, String, u8, U256)',
      'String',
      code,
      async (programId) =>  {
        this._program = await BaseGearProgram.new(programId, this.api);
      }
    );
    return builder;
  }

  /**
   * Deploy a token with the given metadata and per-account faucet amount. The
   * deployer becomes the initial access-control admin (can grant minter roles).
  */
  newCtorFromCodeId(codeId: `0x${string}`, name: string, $symbol: string, decimals: number, faucet_amount: number | string | bigint) {
    const builder = new TransactionBuilder<null>(
      this.api,
      this.registry,
      'create_program',
      null,
      'New',
      [name, $symbol, decimals, faucet_amount],
      '(String, String, u8, U256)',
      'String',
      codeId,
      async (programId) =>  {
        this._program = await BaseGearProgram.new(programId, this.api);
      }
    );
    return builder;
  }
}

export class Vft {
  constructor(private _program: VftProgram) {}

  /**
   * Approves `spender` to spend `value` amount of tokens on behalf of the caller.
   * 
   * If `value` is `U256::MAX`, the allowance is treated as infinite.
   * Emits an `Approval` event if the allowance value changes.
   * 
   * # Arguments
   * 
   * * `spender` - The account to be allowed to spend tokens.
   * * `value` - The amount of tokens to approve.
   * 
   * # Returns
   * 
   * `true` if the approval value was changed, `false` otherwise.
  */
  public approve(spender: ActorId, value: number | string | bigint): TransactionBuilder<boolean> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<boolean>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Vft',
      'Approve',
      [spender, value],
      '([u8;32], U256)',
      'bool',
      this._program.programId,
    );
  }

  /**
   * Transfers `value` amount of tokens from the caller to `to`.
   * 
   * Emits a `Transfer` event.
   * 
   * # Arguments
   * 
   * * `to` - The recipient of the tokens.
   * * `value` - The amount of tokens to transfer.
   * 
   * # Returns
   * 
   * `true` if the transfer was successful.
  */
  public transfer(to: ActorId, value: number | string | bigint): TransactionBuilder<boolean> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<boolean>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Vft',
      'Transfer',
      [to, value],
      '([u8;32], U256)',
      'bool',
      this._program.programId,
    );
  }

  /**
   * Transfers `value` amount of tokens from `from` to `to` using the allowance mechanism.
   * 
   * The caller (spender) must have sufficient allowance from `from` (owner).
   * Emits a `Transfer` event.
   * 
   * # Arguments
   * 
   * * `from` - The account to transfer tokens from.
   * * `to` - The recipient of the tokens.
   * * `value` - The amount of tokens to transfer.
   * 
   * # Returns
   * 
   * `true` if the transfer was successful.
  */
  public transferFrom($from: ActorId, to: ActorId, value: number | string | bigint): TransactionBuilder<boolean> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<boolean>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Vft',
      'TransferFrom',
      [$from, to, value],
      '([u8;32], [u8;32], U256)',
      'bool',
      this._program.programId,
    );
  }

  /**
   * Returns the amount of tokens that `spender` is allowed to spend on behalf of `owner`.
   * 
   * # Arguments
   * 
   * * `owner` - The account that owns the tokens.
   * * `spender` - The account allowed to spend the tokens.
   * 
   * # Returns
   * 
   * The remaining allowance as `U256`.
  */
  public allowance(owner: ActorId, spender: ActorId): QueryBuilder<bigint> {
    return new QueryBuilder<bigint>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Vft',
      'Allowance',
      [owner, spender],
      '([u8;32], [u8;32])',
      'U256',
    );
  }

  /**
   * Returns the token balance of `account`.
   * 
   * # Arguments
   * 
   * * `account` - The account to query the balance of.
   * 
   * # Returns
   * 
   * The balance as `U256`.
  */
  public balanceOf(account: ActorId): QueryBuilder<bigint> {
    return new QueryBuilder<bigint>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Vft',
      'BalanceOf',
      account,
      '[u8;32]',
      'U256',
    );
  }

  /**
   * Returns the total supply of tokens.
   * 
   * # Returns
   * 
   * The total supply as `U256`.
  */
  public totalSupply(): QueryBuilder<bigint> {
    return new QueryBuilder<bigint>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Vft',
      'TotalSupply',
      null,
      null,
      'U256',
    );
  }

  /**
   * Emitted when an approval is granted or updated.
  */
  public subscribeToApprovalEvent(callback: (data: { owner: ActorId; spender: ActorId; value: number | string | bigint }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Vft' && getFnNamePrefix(payload) === 'Approval') {
        callback(this._program.registry.createType('(String, String, {"owner":"[u8;32]","spender":"[u8;32]","value":"U256"})', message.payload)[2].toJSON() as unknown as { owner: ActorId; spender: ActorId; value: number | string | bigint });
      }
    });
  }

  /**
   * Emitted when tokens are transferred.
  */
  public subscribeToTransferEvent(callback: (data: { from: ActorId; to: ActorId; value: number | string | bigint }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Vft' && getFnNamePrefix(payload) === 'Transfer') {
        callback(this._program.registry.createType('(String, String, {"from":"[u8;32]","to":"[u8;32]","value":"U256"})', message.payload)[2].toJSON() as unknown as { from: ActorId; to: ActorId; value: number | string | bigint });
      }
    });
  }
}

export class VftAdmin {
  constructor(private _program: VftProgram) {}

  /**
   * Appends a new shard to the allowances storage map.
   * 
   * # Requirements
   * * Caller must have `DEFAULT_ADMIN_ROLE`.
   * 
   * # Arguments
   * * `capacity` - The capacity of the new shard.
  */
  public appendAllowancesShard(capacity: number): TransactionBuilder<null> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<null>(
      this._program.api,
      this._program.registry,
      'send_message',
      'VftAdmin',
      'AppendAllowancesShard',
      capacity,
      'u32',
      'Null',
      this._program.programId,
    );
  }

  /**
   * Appends a new shard to the balances storage map.
   * 
   * # Requirements
   * * Caller must have `DEFAULT_ADMIN_ROLE`.
   * 
   * # Arguments
   * * `capacity` - The capacity of the new shard.
  */
  public appendBalancesShard(capacity: number): TransactionBuilder<null> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<null>(
      this._program.api,
      this._program.registry,
      'send_message',
      'VftAdmin',
      'AppendBalancesShard',
      capacity,
      'u32',
      'Null',
      this._program.programId,
    );
  }

  /**
   * Approves `spender` to spend `value` from `owner`'s account.
   * 
   * This is an admin function allowing the admin to set approvals arbitrarily.
   * 
   * # Requirements
   * * Caller must have `DEFAULT_ADMIN_ROLE`.
   * 
   * # Arguments
   * * `owner` - The account owning the tokens.
   * * `spender` - The account to be approved.
   * * `value` - The amount to approve.
  */
  public approveFrom(owner: ActorId, spender: ActorId, value: number | string | bigint): TransactionBuilder<boolean> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<boolean>(
      this._program.api,
      this._program.registry,
      'send_message',
      'VftAdmin',
      'ApproveFrom',
      [owner, spender, value],
      '([u8;32], [u8;32], U256)',
      'bool',
      this._program.programId,
    );
  }

  /**
   * Burns `value` tokens from `from` account.
   * 
   * # Requirements
   * * Caller must have `BURNER_ROLE`.
   * 
   * # Arguments
   * * `from` - The account to burn tokens from.
   * * `value` - The amount to burn.
  */
  public burn($from: ActorId, value: number | string | bigint): TransactionBuilder<null> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<null>(
      this._program.api,
      this._program.registry,
      'send_message',
      'VftAdmin',
      'Burn',
      [$from, value],
      '([u8;32], U256)',
      'Null',
      this._program.programId,
    );
  }

  /**
   * Terminates the program and sends value to `inheritor`.
   * 
   * # Requirements
   * * Caller must have `DEFAULT_ADMIN_ROLE`.
   * * Program must be paused.
  */
  public exit(inheritor: ActorId): TransactionBuilder<null> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<null>(
      this._program.api,
      this._program.registry,
      'send_message',
      'VftAdmin',
      'Exit',
      inheritor,
      '[u8;32]',
      'Null',
      this._program.programId,
    );
  }

  /**
   * Mints `value` tokens to `to` account.
   * 
   * # Requirements
   * * Caller must have `MINTER_ROLE`.
   * 
   * # Arguments
   * * `to` - The recipient of the minted tokens.
   * * `value` - The amount to mint.
  */
  public mint(to: ActorId, value: number | string | bigint): TransactionBuilder<null> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<null>(
      this._program.api,
      this._program.registry,
      'send_message',
      'VftAdmin',
      'Mint',
      [to, value],
      '([u8;32], U256)',
      'Null',
      this._program.programId,
    );
  }

  /**
   * Pauses the contract.
   * 
   * # Requirements
   * * Caller must have `PAUSER_ROLE`.
  */
  public pause(): TransactionBuilder<null> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<null>(
      this._program.api,
      this._program.registry,
      'send_message',
      'VftAdmin',
      'Pause',
      null,
      null,
      'Null',
      this._program.programId,
    );
  }

  /**
   * Resumes the contract.
   * 
   * # Requirements
   * * Caller must have `PAUSER_ROLE`.
  */
  public resume(): TransactionBuilder<null> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<null>(
      this._program.api,
      this._program.registry,
      'send_message',
      'VftAdmin',
      'Resume',
      null,
      null,
      'Null',
      this._program.programId,
    );
  }

  /**
   * Sets the expiry period for allowances.
   * 
   * # Requirements
   * * Caller must have `DEFAULT_ADMIN_ROLE`.
   * 
   * # Arguments
   * * `period` - The new expiry period in blocks.
  */
  public setExpiryPeriod(period: number): TransactionBuilder<null> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<null>(
      this._program.api,
      this._program.registry,
      'send_message',
      'VftAdmin',
      'SetExpiryPeriod',
      period,
      'u32',
      'Null',
      this._program.programId,
    );
  }

  /**
   * Returns `true` if the contract is paused.
  */
  public isPaused(): QueryBuilder<boolean> {
    return new QueryBuilder<boolean>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'VftAdmin',
      'IsPaused',
      null,
      null,
      'bool',
    );
  }

  /**
   * Emitted when a burn operation occurs.
  */
  public subscribeToBurnerTookPlaceEvent(callback: (data: null) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'VftAdmin' && getFnNamePrefix(payload) === 'BurnerTookPlace') {
        callback(null);
      }
    });
  }

  /**
   * Emitted when a mint operation occurs.
  */
  public subscribeToMinterTookPlaceEvent(callback: (data: null) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'VftAdmin' && getFnNamePrefix(payload) === 'MinterTookPlace') {
        callback(null);
      }
    });
  }

  /**
   * Emitted when the allowance expiry period is changed.
  */
  public subscribeToExpiryPeriodChangedEvent(callback: (data: number) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'VftAdmin' && getFnNamePrefix(payload) === 'ExpiryPeriodChanged') {
        callback(this._program.registry.createType('(String, String, u32)', message.payload)[2].toNumber() as unknown as number);
      }
    });
  }

  /**
   * Emitted when the program exits.
  */
  public subscribeToExitedEvent(callback: (data: ActorId) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'VftAdmin' && getFnNamePrefix(payload) === 'Exited') {
        callback(this._program.registry.createType('(String, String, [u8;32])', message.payload)[2].toJSON() as unknown as ActorId);
      }
    });
  }

  /**
   * Emitted when the contract is paused.
  */
  public subscribeToPausedEvent(callback: (data: null) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'VftAdmin' && getFnNamePrefix(payload) === 'Paused') {
        callback(null);
      }
    });
  }

  /**
   * Emitted when the contract is resumed.
  */
  public subscribeToResumedEvent(callback: (data: null) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'VftAdmin' && getFnNamePrefix(payload) === 'Resumed') {
        callback(null);
      }
    });
  }
}

export class VftMetadata {
  constructor(private _program: VftProgram) {}

  /**
   * Returns the number of decimals used by the VFT.
   * 
   * # Returns
   * 
   * The decimals as a `u8`.
  */
  public decimals(): QueryBuilder<number> {
    return new QueryBuilder<number>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'VftMetadata',
      'Decimals',
      null,
      null,
      'u8',
    );
  }

  /**
   * Returns the name of the VFT.
   * 
   * # Returns
   * 
   * The name as a `String`.
  */
  public name(): QueryBuilder<string> {
    return new QueryBuilder<string>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'VftMetadata',
      'Name',
      null,
      null,
      'String',
    );
  }

  /**
   * Returns the symbol of the VFT.
   * 
   * # Returns
   * 
   * The symbol as a `String`.
  */
  public symbol(): QueryBuilder<string> {
    return new QueryBuilder<string>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'VftMetadata',
      'Symbol',
      null,
      null,
      'String',
    );
  }
}

export class AccessControl {
  constructor(private _program: VftProgram) {}

  /**
   * Grants `role_id` to `target_account`.
   * 
   * If `target_account` had not been already granted `role_id`, emits a `RoleGranted`
   * event.
   * 
   * # Requirements
   * 
   * * The caller must have `role_id`'s admin role.
  */
  public grantRole(role_id: Array<number>, target_account: ActorId): TransactionBuilder<null> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<null>(
      this._program.api,
      this._program.registry,
      'send_message',
      'AccessControl',
      'GrantRole',
      [role_id, target_account],
      '([u8; 32], [u8;32])',
      'Null',
      this._program.programId,
    );
  }

  /**
   * Grants `role_ids` to `target_account`.
   * 
   * If `target_account` had not been already granted any of the `role_ids`,
   * emits a `RoleGranted` event for each newly granted role.
   * 
   * # Requirements
   * 
   * * The caller must have the admin role for all specified `role_ids`.
  */
  public grantRolesBatch(role_ids: Array<Array<number>>, target_account: ActorId): TransactionBuilder<null> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<null>(
      this._program.api,
      this._program.registry,
      'send_message',
      'AccessControl',
      'GrantRolesBatch',
      [role_ids, target_account],
      '(Vec<[u8; 32]>, [u8;32])',
      'Null',
      this._program.programId,
    );
  }

  /**
   * Revokes `role_id` from the calling account.
   * 
   * Roles are often managed via `grant_role` and `revoke_role`: this function's
   * purpose is to provide a mechanism for accounts to lose their privileges
   * if they are compromised (such as when a trusted device is misplaced).
   * 
   * If the calling account had been granted `role_id`, emits a `RoleRevoked`
   * event.
   * 
   * # Requirements
   * 
   * * The caller must be `account_id`.
  */
  public renounceRole(role_id: Array<number>, account_id: ActorId): TransactionBuilder<null> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<null>(
      this._program.api,
      this._program.registry,
      'send_message',
      'AccessControl',
      'RenounceRole',
      [role_id, account_id],
      '([u8; 32], [u8;32])',
      'Null',
      this._program.programId,
    );
  }

  /**
   * Revokes `role_id` from `target_account`.
   * 
   * If `target_account` had been granted `role_id`, emits a `RoleRevoked` event.
   * 
   * # Requirements
   * 
   * * The caller must have `role_id`'s admin role.
  */
  public revokeRole(role_id: Array<number>, target_account: ActorId): TransactionBuilder<null> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<null>(
      this._program.api,
      this._program.registry,
      'send_message',
      'AccessControl',
      'RevokeRole',
      [role_id, target_account],
      '([u8; 32], [u8;32])',
      'Null',
      this._program.programId,
    );
  }

  /**
   * Revokes `role_ids` from `target_account`.
   * 
   * If `target_account` had been granted any of the `role_ids`,
   * emits a `RoleRevoked` event for each newly revoked role.
   * 
   * # Requirements
   * 
   * * The caller must have the admin role for all specified `role_ids`.
  */
  public revokeRolesBatch(role_ids: Array<Array<number>>, target_account: ActorId): TransactionBuilder<null> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<null>(
      this._program.api,
      this._program.registry,
      'send_message',
      'AccessControl',
      'RevokeRolesBatch',
      [role_ids, target_account],
      '(Vec<[u8; 32]>, [u8;32])',
      'Null',
      this._program.programId,
    );
  }

  /**
   * Sets `new_admin_role_id` as the admin role for `role_id`.
   * 
   * Emits a `RoleAdminChanged` event.
   * 
   * # Requirements
   * 
   * * The caller must have `role_id`'s admin role.
  */
  public setRoleAdmin(role_id: Array<number>, new_admin_role_id: Array<number>): TransactionBuilder<null> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<null>(
      this._program.api,
      this._program.registry,
      'send_message',
      'AccessControl',
      'SetRoleAdmin',
      [role_id, new_admin_role_id],
      '([u8; 32], [u8; 32])',
      'Null',
      this._program.programId,
    );
  }

  /**
   * Returns the number of roles assigned to the specified member.
   * 
   * # Arguments
   * 
   * * `member_id` - The account identifier.
  */
  public getMemberRoleCount(member_id: ActorId): QueryBuilder<number> {
    return new QueryBuilder<number>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'AccessControl',
      'GetMemberRoleCount',
      member_id,
      '[u8;32]',
      'u32',
    );
  }

  /**
   * Returns a list of roles assigned to the specified member with pagination.
   * 
   * # Arguments
   * 
   * * `member_id` - The account identifier.
   * * `query` - Optional pagination configuration.
  */
  public getMemberRoles(member_id: ActorId, query: Pagination | null): QueryBuilder<Array<Array<number>>> {
    return new QueryBuilder<Array<Array<number>>>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'AccessControl',
      'GetMemberRoles',
      [member_id, query],
      '([u8;32], Option<Pagination>)',
      'Vec<[u8; 32]>',
    );
  }

  /**
   * Returns the admin role ID that controls `role_id`.
   * 
   * # Arguments
   * 
   * * `role_id` - The role identifier.
   * 
   * # Returns
   * 
   * The `RoleId` of the administrator.
  */
  public getRoleAdmin(role_id: Array<number>): QueryBuilder<Array<number>> {
    return new QueryBuilder<Array<number>>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'AccessControl',
      'GetRoleAdmin',
      role_id,
      '[u8; 32]',
      '[u8; 32]',
    );
  }

  /**
   * Returns the total number of roles in the system.
  */
  public getRoleCount(): QueryBuilder<number> {
    return new QueryBuilder<number>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'AccessControl',
      'GetRoleCount',
      null,
      null,
      'u32',
    );
  }

  /**
   * Returns the number of members in the specified role.
   * 
   * # Arguments
   * 
   * * `role_id` - The role identifier.
  */
  public getRoleMemberCount(role_id: Array<number>): QueryBuilder<number> {
    return new QueryBuilder<number>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'AccessControl',
      'GetRoleMemberCount',
      role_id,
      '[u8; 32]',
      'u32',
    );
  }

  /**
   * Returns a list of members in the specified role with pagination.
   * 
   * # Arguments
   * 
   * * `role_id` - The role identifier.
   * * `query` - Optional pagination configuration.
  */
  public getRoleMembers(role_id: Array<number>, query: Pagination | null): QueryBuilder<Array<ActorId>> {
    return new QueryBuilder<Array<ActorId>>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'AccessControl',
      'GetRoleMembers',
      [role_id, query],
      '([u8; 32], Option<Pagination>)',
      'Vec<[u8;32]>',
    );
  }

  /**
   * Returns a list of role IDs with pagination.
   * 
   * # Arguments
   * 
   * * `query` - Optional pagination configuration.
  */
  public getRoles(query: Pagination | null): QueryBuilder<Array<Array<number>>> {
    return new QueryBuilder<Array<Array<number>>>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'AccessControl',
      'GetRoles',
      query,
      'Option<Pagination>',
      'Vec<[u8; 32]>',
    );
  }

  /**
   * Checks if `account_id` has been granted `role_id`.
   * 
   * # Arguments
   * 
   * * `role_id` - The role identifier.
   * * `account_id` - The account identifier.
   * 
   * # Returns
   * 
   * `true` if the account possesses the role.
  */
  public hasRole(role_id: Array<number>, account_id: ActorId): QueryBuilder<boolean> {
    return new QueryBuilder<boolean>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'AccessControl',
      'HasRole',
      [role_id, account_id],
      '([u8; 32], [u8;32])',
      'bool',
    );
  }

  /**
   * Emitted when `target_account` is granted `role_id`.
  */
  public subscribeToRoleGrantedEvent(callback: (data: { role_id: Array<number>; target_account: ActorId; sender: ActorId }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'AccessControl' && getFnNamePrefix(payload) === 'RoleGranted') {
        callback(this._program.registry.createType('(String, String, {"role_id":"[u8; 32]","target_account":"[u8;32]","sender":"[u8;32]"})', message.payload)[2].toJSON() as unknown as { role_id: Array<number>; target_account: ActorId; sender: ActorId });
      }
    });
  }

  /**
   * Emitted when `role_id` is revoked from `target_account`.
  */
  public subscribeToRoleRevokedEvent(callback: (data: { role_id: Array<number>; target_account: ActorId; sender: ActorId }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'AccessControl' && getFnNamePrefix(payload) === 'RoleRevoked') {
        callback(this._program.registry.createType('(String, String, {"role_id":"[u8; 32]","target_account":"[u8;32]","sender":"[u8;32]"})', message.payload)[2].toJSON() as unknown as { role_id: Array<number>; target_account: ActorId; sender: ActorId });
      }
    });
  }

  /**
   * Emitted when `new_admin_role_id` is set as the admin role for `role_id`.
  */
  public subscribeToRoleAdminChangedEvent(callback: (data: { role_id: Array<number>; previous_admin_role_id: Array<number>; new_admin_role_id: Array<number>; sender: ActorId }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'AccessControl' && getFnNamePrefix(payload) === 'RoleAdminChanged') {
        callback(this._program.registry.createType('(String, String, {"role_id":"[u8; 32]","previous_admin_role_id":"[u8; 32]","new_admin_role_id":"[u8; 32]","sender":"[u8;32]"})', message.payload)[2].toJSON() as unknown as { role_id: Array<number>; previous_admin_role_id: Array<number>; new_admin_role_id: Array<number>; sender: ActorId });
      }
    });
  }
}

export class Faucet {
  constructor(private _program: VftProgram) {}

  /**
   * Mint `faucet_amount` tokens to the caller. Errors if they have claimed before.
  */
  public claim(): TransactionBuilder<{ ok: number | string | bigint } | { err: FaucetError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: number | string | bigint } | { err: FaucetError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Faucet',
      'Claim',
      null,
      null,
      'Result<U256, FaucetError>',
      this._program.programId,
    );
  }

  /**
   * Whether `who` has already claimed.
  */
  public hasClaimed(who: ActorId): QueryBuilder<boolean> {
    return new QueryBuilder<boolean>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Faucet',
      'HasClaimed',
      who,
      '[u8;32]',
      'bool',
    );
  }
}