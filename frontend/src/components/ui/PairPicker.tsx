import { useMemo } from 'react';
import { Select } from './Select';
import { useTokenSymbols } from '../../hooks/useSpot';

interface Props {
  pairs: SpotPair[];
  /** Selected pair id as a string (Select works in strings). */
  value: string;
  onChange: (pairId: string) => void;
  className?: string;
}

/**
 * Market selector for the spot CLOB. Replaces the old hardcoded BTC/ETH/VARA toggle:
 * the market list is whatever the admin has curated on-chain (`Spot/GetPairs`), shown
 * as BASE/QUOTE using each token's VFT symbol.
 */
export function PairPicker({ pairs, value, onChange, className }: Props) {
  const tokens = useMemo(() => {
    const set = new Set<string>();
    for (const p of pairs) {
      set.add(String(p.base));
      set.add(String(p.quote));
    }
    return [...set];
  }, [pairs]);
  const symbols = useTokenSymbols(tokens);

  const options = useMemo(
    () =>
      pairs
        .filter((p) => p.active)
        .map((p) => {
          const base = symbols[String(p.base)] ?? '…';
          const quote = symbols[String(p.quote)] ?? '…';
          return { value: String(p.id), label: `${base}/${quote}` };
        }),
    [pairs, symbols],
  );

  return (
    <Select
      value={value}
      onChange={onChange}
      options={options}
      ariaLabel="Select market"
      className={className}
    />
  );
}
