import { describe, it, expect } from 'vitest';
import { parseContractError } from './errors';

describe('parseContractError', () => {
  it('maps known contract error codes to human messages', () => {
    expect(parseContractError('InsufficientUsd')).toMatch(/USD/i);
    expect(parseContractError('StaleMark')).toMatch(/mark price is stale/i);
    expect(parseContractError('LeverageTooHigh')).toMatch(/leverage/i);
    expect(parseContractError('NotLiquidatable')).toMatch(/maintenance margin/i);
    expect(parseContractError('BookFull')).toMatch(/order book is full/i);
  });

  it('recognizes a code embedded in a larger error string', () => {
    expect(parseContractError('Execution error: { err: "StaleMark" }')).toMatch(/stale/i);
  });

  it('handles wallet / network failures gracefully', () => {
    expect(parseContractError('signAndSend rejected')).toMatch(/wallet|network/i);
    expect(parseContractError(null)).toBe('Unknown error');
  });

  it('passes through short unknown messages, truncates long ones', () => {
    expect(parseContractError('boom')).toBe('boom');
    expect(parseContractError('x'.repeat(200))).toMatch(/failed/i);
  });
});
