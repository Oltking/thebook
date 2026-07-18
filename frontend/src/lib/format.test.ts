import { describe, it, expect } from 'vitest';
import { formatUsdPrice, formatUsd } from './format';

describe('formatUsdPrice', () => {
  it('formats large prices with 2 decimals + grouping', () => {
    expect(formatUsdPrice(64208.1)).toBe('$64,208.10');
    expect(formatUsdPrice(1887.9)).toBe('$1,887.90');
  });

  it('formats mid prices (>= 0.01) with 4 decimals', () => {
    expect(formatUsdPrice(0.0123)).toBe('$0.0123');
    expect(formatUsdPrice(0.5)).toBe('$0.5000');
  });

  it('compresses tiny prices into subscript-zero notation', () => {
    // 0.00000123 → three+ leading zeros → subscript count
    expect(formatUsdPrice(0.00000123)).toBe('$0.0₅123');
    expect(formatUsdPrice(0.000045)).toBe('$0.0₄45');
  });

  it('returns a dash for missing / non-positive values', () => {
    expect(formatUsdPrice(null)).toBe('-');
    expect(formatUsdPrice(undefined)).toBe('-');
    expect(formatUsdPrice(0)).toBe('-');
    expect(formatUsdPrice(NaN)).toBe('-');
  });
});

describe('formatUsd', () => {
  it('always shows two decimals', () => {
    expect(formatUsd(1000)).toBe('$1,000.00');
    expect(formatUsd(0)).toBe('$0.00');
  });
  it('handles missing values', () => {
    expect(formatUsd(null)).toBe('-');
  });
});
