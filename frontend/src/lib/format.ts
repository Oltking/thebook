// Price / number formatting shared across the app.

const SUBS = '₀₁₂₃₄₅₆₇₈₉';
const toSub = (n: number) => String(n).split('').map((d) => SUBS[+d]).join('');

/**
 * Format a USD price with sensible precision. Large prices get 2 decimals; small
 * ones (like VARA) keep significant digits, compressing long runs of leading zeros
 * into subscript notation - e.g. 0.00000123 → "$0.0₅123".
 */
export function formatUsdPrice(v: number | null | undefined): string {
  if (v == null || !isFinite(v) || v <= 0) return '-';
  if (v >= 1) return '$' + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (v >= 0.01) return '$' + v.toFixed(4);

  // Sub-cent: count leading zeros after the decimal point, then show 3 sig digits.
  const dec = v.toFixed(20).split('.')[1] ?? '';
  let zeros = 0;
  while (dec[zeros] === '0') zeros++;
  const sig = (dec.slice(zeros, zeros + 3).replace(/0+$/, '')) || '0';
  return zeros >= 3 ? `$0.0${toSub(zeros)}${sig}` : `$0.${'0'.repeat(zeros)}${sig}`;
}

/** Plain USD (dollars), always 2 decimals. */
export function formatUsd(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return '-';
  return '$' + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
