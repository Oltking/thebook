// Convert between human decimal strings and on-chain smallest-units (bigint).
// Spot amounts/prices are u128 in token smallest-units; a token declares its decimals.

/** A plain, unsigned decimal number: digits, at most one point, digits. */
const DECIMAL = /^\d*(\.\d*)?$/;

/**
 * Parse a human decimal string ("1.25") to smallest-units given `decimals`.
 *
 * Returns `0n` for anything that is not a plain decimal number. This function sits
 * on the order-entry path and used to hand its input straight to `BigInt()`, which
 * made ordinary mistyping dangerous in two different ways (audit M-01):
 *
 *   "abc"   → threw, and with no error boundary in the tree that blanked the app
 *   "1e3"   → threw the same way
 *   "0x10"  → did *not* throw; `BigInt` parsed it as hex and silently returned
 *             268.435456 for what the user typed as a small number
 *   "1.2.3" → silently dropped the third component
 *
 * `inputMode="decimal"` is a keyboard hint, not a constraint — paste, desktop
 * keyboards and autofill all bypass it — so the validation has to live here.
 */
export function parseUnits(value: string, decimals: number): bigint {
  if (typeof value !== 'string') return 0n;
  const v = value.trim();
  if (!v) return 0n;
  const neg = v.startsWith('-');
  const clean = (neg ? v.slice(1) : v).replace(/,/g, '');
  // Rejects hex, exponents, whitespace, multiple points, and stray characters.
  if (!DECIMAL.test(clean) || clean === '' || clean === '.') return 0n;
  const [whole = '0', frac = ''] = clean.split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const digits = `${whole}${fracPadded}`.replace(/^0+(?=\d)/, '');
  const out = BigInt(digits || '0');
  return neg ? -out : out;
}

/** Whether `value` is something `parseUnits` will accept as a number. Use this to
 *  show the user an inline error rather than silently treating input as zero. */
export function isValidDecimal(value: string): boolean {
  const v = (value ?? '').trim().replace(/,/g, '');
  const body = v.startsWith('-') ? v.slice(1) : v;
  return body !== '' && body !== '.' && DECIMAL.test(body);
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

/**
 * How many fractional digits a price needs to stay readable.
 *
 * A fixed 2 decimals is wrong for sub-cent assets: VARA at $0.00042 renders as
 * "0.00", and once trailing zeros are stripped, as plain "0". A price of zero and a
 * price too small to show at the chosen precision look identical to the user, which
 * on a trading screen is the difference between "this market is broken" and "this
 * market is cheap".
 *
 * Capped by the token's own decimals, since no more can be represented.
 */
export function priceFractionDigits(approxValue: number, decimals: number): number {
  const want =
    approxValue >= 1 ? 2
      : approxValue >= 0.01 ? 4
        : approxValue > 0 ? 8
          : 2;
  return Math.min(want, decimals);
}

/**
 * Format an on-chain price for display, choosing precision from its magnitude.
 *
 * Use this anywhere a price is shown; `formatUnits` with a hardcoded digit count is
 * what produced "$0" for VARA on both the spot form and the perps mark.
 */
export function formatPrice(raw: bigint, decimals: number): string {
  if (raw <= 0n) return '0';
  const approx = Number(raw) / 10 ** decimals;
  const digits = priceFractionDigits(approx, decimals);
  const out = formatUnits(raw, decimals, digits);
  // A non-zero price must never render as "0". If it is smaller than the chosen
  // precision can show, say so explicitly rather than claiming zero: those two mean
  // very different things to someone deciding whether to trade.
  if (out === '0' || out === '-0') {
    const smallest = formatUnits(1n, digits, digits);
    return `${raw < 0n ? '>-' : '<'}${smallest}`;
  }
  return out;
}
