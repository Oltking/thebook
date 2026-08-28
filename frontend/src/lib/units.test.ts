import { describe, expect, it } from 'vitest';
import { formatUnits, isValidDecimal, notional, parseUnits } from './units';

/**
 * `units.ts` converts every user keystroke into an on-chain amount and had no tests
 * at all (audit M-15). The cases below are exactly the inputs the audit found
 * crashing the app or silently corrupting the order (audit M-01).
 */
describe('parseUnits', () => {
  it('parses plain decimals', () => {
    expect(parseUnits('1.25', 6)).toBe(1_250_000n);
    expect(parseUnits('1', 6)).toBe(1_000_000n);
    expect(parseUnits('0.000001', 6)).toBe(1n);
    expect(parseUnits('', 6)).toBe(0n);
    expect(parseUnits('.', 6)).toBe(0n);
  });

  it('truncates beyond the token precision rather than rounding up', () => {
    // Rounding up would let an order escrow more than the user typed.
    expect(parseUnits('1.9999999', 6)).toBe(1_999_999n);
  });

  it('handles thousands separators and whitespace', () => {
    expect(parseUnits(' 1,250.50 ', 6)).toBe(1_250_500_000n);
  });

  it('returns 0n for input that used to throw and blank the app', () => {
    expect(parseUnits('abc', 6)).toBe(0n);
    expect(parseUnits('1e3', 6)).toBe(0n);
    expect(parseUnits('1 000', 6)).toBe(0n);
    expect(parseUnits('--1', 6)).toBe(0n);
  });

  it('does not parse hex — the silent-corruption case', () => {
    // BigInt('0x10' + zeros) used to return 268435456: 268.435456 tokens for what
    // the user typed as a small number, with no error anywhere.
    expect(parseUnits('0x10', 6)).toBe(0n);
  });

  it('rejects multiple decimal points instead of dropping a component', () => {
    expect(parseUnits('1.2.3', 6)).toBe(0n);
  });

  it('never throws, whatever it is given', () => {
    for (const bad of ['abc', '0x10', '1e3', '1.2.3', '∞', '- 1', 'NaN', '1,,2', '..']) {
      expect(() => parseUnits(bad, 6)).not.toThrow();
    }
  });
});

describe('isValidDecimal', () => {
  it('accepts what parseUnits can parse', () => {
    for (const ok of ['1', '1.25', '0.5', '.5', '1,250.50', '-3']) {
      expect(isValidDecimal(ok)).toBe(true);
    }
  });
  it('rejects what parseUnits treats as zero', () => {
    for (const bad of ['', '.', 'abc', '0x10', '1e3', '1.2.3', '1 000']) {
      expect(isValidDecimal(bad)).toBe(false);
    }
  });
});

describe('formatUnits', () => {
  it('round-trips with parseUnits', () => {
    for (const v of ['1.25', '0.000001', '1000', '0.5']) {
      expect(formatUnits(parseUnits(v, 6), 6)).toBe(String(Number(v)));
    }
  });

  it('trims trailing zeros and handles negatives', () => {
    expect(formatUnits(1_250_000n, 6)).toBe('1.25');
    expect(formatUnits(1_000_000n, 6)).toBe('1');
    expect(formatUnits(-1_250_000n, 6)).toBe('-1.25');
    expect(formatUnits(0n, 6)).toBe('0');
  });

  it('respects maxFrac', () => {
    expect(formatUnits(1_234_567n, 6, 2)).toBe('1.23');
  });

  it('handles sub-cent assets without collapsing to zero', () => {
    // VARA is ~$0.000426; formatting it to 2 places is what showed "0.00".
    expect(formatUnits(426n, 6)).toBe('0.000426');
  });
});

describe('notional', () => {
  it('scales by base decimals', () => {
    // 2 whole base (dec 5 => 200_000 units) at price 3 quote per whole = 6 quote.
    expect(notional(3n, 200_000n, 5)).toBe(6n);
    expect(notional(10n, 50_000n, 5)).toBe(5n);
  });

  it('floors, so the contract is never short', () => {
    expect(notional(3n, 1n, 6)).toBe(0n);
  });

  it('agrees with the contract on a realistic ETH/USDT order', () => {
    // 0.5 wETH (18 dec) at 2500 USDT (6 dec) per whole ETH = 1250 USDT.
    expect(notional(2_500_000_000n, 500_000_000_000_000_000n, 18)).toBe(1_250_000_000n);
  });
});
