/* eslint-disable */

// Minimal client for the thebook-token VFT program (one instance per wrapped
// asset). Exposes the faucet `claim`, ERC-20-style `approve`, and `balanceOf`
// needed for the claim → approve → deposit onboarding flow.

import { GearApi, BaseGearProgram } from '@gear-js/api';
import { TypeRegistry } from '@polkadot/types';
import { TransactionBuilder, QueryBuilder } from 'sails-js';
import type { ActorId } from 'sails-js';

export type TokenU256 = number | string | bigint;

export class TokenProgram {
  public readonly registry: TypeRegistry;
  private _program: BaseGearProgram;

  constructor(public api: GearApi, programId: `0x${string}`) {
    const types: Record<string, any> = {
      FaucetError: { _enum: ['AlreadyClaimed', 'MintFailed'] },
    };
    this.registry = new TypeRegistry();
    this.registry.setKnownTypes({ types });
    this.registry.register(types);
    this._program = new BaseGearProgram(programId, api);
  }

  public get programId(): `0x${string}` {
    return this._program.id;
  }

  /** Faucet: mint the per-account amount to the caller (once per account). */
  public claim(): TransactionBuilder<{ ok: TokenU256 } | { err: string }> {
    return new TransactionBuilder<{ ok: TokenU256 } | { err: string }>(
      this.api,
      this.registry,
      'send_message',
      'Faucet',
      'Claim',
      null,
      null,
      'Result<U256, FaucetError>',
      this.programId,
    );
  }

  /** ERC-20 approve: let `spender` (the DEX) move up to `value` of the caller's tokens. */
  public approve(spender: ActorId, value: TokenU256): TransactionBuilder<boolean> {
    return new TransactionBuilder<boolean>(
      this.api,
      this.registry,
      'send_message',
      'Vft',
      'Approve',
      [spender, value],
      '([u8;32], U256)',
      'bool',
      this.programId,
    );
  }

  public balanceOf(account: ActorId): QueryBuilder<TokenU256> {
    return new QueryBuilder<TokenU256>(
      this.api,
      this.registry,
      this.programId,
      'Vft',
      'BalanceOf',
      account,
      '[u8;32]',
      'U256',
    );
  }

  public allowance(owner: ActorId, spender: ActorId): QueryBuilder<TokenU256> {
    return new QueryBuilder<TokenU256>(
      this.api,
      this.registry,
      this.programId,
      'Vft',
      'Allowance',
      [owner, spender],
      '([u8;32], [u8;32])',
      'U256',
    );
  }

  public hasClaimed(who: ActorId): QueryBuilder<boolean> {
    return new QueryBuilder<boolean>(
      this.api,
      this.registry,
      this.programId,
      'Faucet',
      'HasClaimed',
      who,
      '[u8;32]',
      'bool',
    );
  }
}
