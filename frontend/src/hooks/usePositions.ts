import { useState, useCallback, useEffect } from 'react';

const BASE_KEY = 'thebookdex:positions';

export interface FuturesPosition {
  id: string;
  asset: string;
  direction: 'Long' | 'Short';
  entryPrice: number;
  sizeQty: number;
  leverage: number;
  margin: number;
  openedAt: string;
}

function loadFor(address: string): FuturesPosition[] {
  try {
    const walletKey = `${BASE_KEY}:${address}`;
    const walletRaw = localStorage.getItem(walletKey);
    if (walletRaw) return JSON.parse(walletRaw);

    /* Migrate positions saved before wallet-scoping was introduced */
    const legacyRaw = localStorage.getItem(BASE_KEY);
    if (legacyRaw) {
      localStorage.setItem(walletKey, legacyRaw);
      localStorage.removeItem(BASE_KEY);
      return JSON.parse(legacyRaw);
    }
  } catch {}
  return [];
}

function persistFor(address: string, positions: FuturesPosition[]) {
  try {
    localStorage.setItem(`${BASE_KEY}:${address}`, JSON.stringify(positions.slice(-50)));
  } catch {}
}

export function usePositions(address?: string) {
  /* Lazy initializer — loads immediately on first render if address is known */
  const [positions, setPositions] = useState<FuturesPosition[]>(() =>
    address ? loadFor(address) : []
  );

  /* Re-load whenever the connected wallet changes */
  useEffect(() => {
    setPositions(address ? loadFor(address) : []);
  }, [address]);

  const addPosition = useCallback((p: FuturesPosition) => {
    if (!address) return;
    setPositions(prev => {
      const next = [...prev, p];
      persistFor(address, next);
      return next;
    });
  }, [address]);

  const removePosition = useCallback((id: string) => {
    if (!address) return;
    setPositions(prev => {
      const next = prev.filter(p => p.id !== id);
      persistFor(address, next);
      return next;
    });
  }, [address]);

  const unrealizedPnl = useCallback((pos: FuturesPosition, markPrice: number): number => {
    if (!markPrice || !pos.entryPrice) return 0;
    const size = pos.sizeQty / 1e5;
    return pos.direction === 'Long'
      ? (markPrice - pos.entryPrice) * size
      : (pos.entryPrice - markPrice) * size;
  }, []);

  const liqPrice = useCallback((pos: FuturesPosition): number => {
    const margin = 0.9 / Math.max(pos.leverage, 1);
    return pos.direction === 'Long'
      ? pos.entryPrice * (1 - margin)
      : pos.entryPrice * (1 + margin);
  }, []);

  return { positions, addPosition, removePosition, unrealizedPnl, liqPrice };
}
