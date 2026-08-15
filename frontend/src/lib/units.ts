// Convert between human decimal strings and on-chain smallest-units (bigint).
// Spot amounts/prices are u128 in token smallest-units; a token declares its decimals.

/** Parse a human decimal string ("1.25") to smallest-units given `decimals`. */
export function parseUnits(value: string, decimals: number): bigint {
  const v = value.trim();
  if (!v || v === '.') return 0n;
  const neg = v.startsWith('-');
  const clean = (neg ? v.slice(1) : v).replace(/,/g, '');
  const [whole = '0', frac = ''] = clean.split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const digits = `${whole}${fracPadded}`.replace(/^0+(?=\d)/, '');
  const out = BigInt(digits || '0');
  return neg ? -out : out;
}

/** Format smallest-units to a human string with up to `maxFrac` fractional digits. */
export function formatUnits(amount: bigint, decimals: number, maxFrac = 6): string {
  const negative = amount < 0n;
  const a = negative ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = a / base;
  let frac = (a % base).toString().padStart(decimals, '0');
  if (maxFrac < decimals) frac = frac.slice(0, maxFrac);
  frac = frac.replace(/0+$/, '');
  const body = frac ? `${whole}.${frac}` : `${whole}`;
  return negative ? `-${body}` : body;
}

/** Quote smallest-units for `qty` base-units at on-chain `price` (quote per whole base). */
export function notional(price: bigint, qty: bigint, baseDec: number): bigint {
  return (price * qty) / 10n ** BigInt(baseDec);
}
