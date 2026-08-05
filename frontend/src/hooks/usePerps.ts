import { useCallback, useEffect, useState } from 'react';
import { useSails } from './useSails';
import { useVoucher } from '../providers/VoucherProvider';
import { web3FromSource } from '@polkadot/extension-dapp';

// On-chain scales: prices/margin/usd are in micro-dollars ($1 = 1e6), size is in
// asset units (1e5).
const USD_UNIT = 1e6;
const ASSET_UNIT = 1e5;

export interface PerpPosition {
  asset: Asset;
  isLong: boolean;
  size: number;        // asset units (e.g. 0.0123 BTC)
  entry: number;       // USD
  margin: number;      // USD
  leverage: number;
  pnl: number;         // USD, at current mark
  liqPrice: number;    // USD
}

export interface PerpMarks {
  BTC: number;
  ETH: number;
  VARA: number;
}

const POLL_MS = 5_000;

export function usePerps() {
  const { program, account, isReady } = useSails();
  const { apply: applyVoucher } = useVoucher();
  const [positions, setPositions] = useState<PerpPosition[]>([]);
  const [marks, setMarks] = useState<PerpMarks>({ BTC: 0, ETH: 0, VARA: 0 });
  const [reserve, setReserve] = useState(0);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!program || !isReady) return;
    try {
      const [b, e, v]: any = await program.perps.getMarkPrices().call();
      setMarks({ BTC: Number(b) / USD_UNIT, ETH: Number(e) / USD_UNIT, VARA: Number(v) / USD_UNIT });
      const res: any = await program.perps.getReserve().call();
      setReserve(Number(res) / USD_UNIT);
      if (account) {
        const raw: any[] = await program.perps.getPositions(account.decodedAddress).call();
        const parsed: PerpPosition[] = [];
        for (const p of raw || []) {
          const asset = p[0] as Asset;
          const liqRaw: any = await program.perps.getLiqPrice(account.decodedAddress, asset).call().catch(() => 0);
          parsed.push({
            asset,
            isLong: Boolean(p[1]),
            size: Number(p[2]) / ASSET_UNIT,
            entry: Number(p[3]) / USD_UNIT,
            margin: Number(p[4]) / USD_UNIT,
            leverage: Number(p[5]),
            pnl: Number(p[6]) / USD_UNIT,
            liqPrice: Number(liqRaw) / USD_UNIT,
          });
        }
        setPositions(parsed);
      } else {
        setPositions([]);
      }
    } catch (err) {
      console.error('usePerps refresh failed:', err);
    }
  }, [program, account, isReady]);

  useEffect(() => {
    if (!isReady) return;
    refresh();
    const id = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
    return () => clearInterval(id);
  }, [isReady, refresh]);

  const send = useCallback(async (buildTx: () => any): Promise<string | null> => {
    if (!program || !account) return 'Wallet not ready';
    setBusy(true);
    try {
      const { signer } = await web3FromSource(account.meta.source);
      const tx = buildTx();
      await applyVoucher(tx.withAccount(account.address, { signer })).calculateGas(true, 100);
      const { response } = await tx.signAndSend();
      const result = await response();
      if (result && typeof result === 'object' && 'err' in result) {
        return JSON.stringify((result as any).err);
      }
      return null;
    } catch (e: any) {
      return e?.message || String(e);
    } finally {
      setBusy(false);
    }
  }, [program, account]);

  /** Open a position. `marginUsd` is human USD; leverage is an integer. */
  const openPosition = useCallback(async (asset: Asset, isLong: boolean, marginUsd: number, leverage: number): Promise<string | null> => {
    const marginMicros = BigInt(Math.round(marginUsd * USD_UNIT));
    const err = await send(() => program!.perps.openPosition(asset, isLong, marginMicros.toString(), leverage));
    if (!err) setTimeout(refresh, 1500);
    return err;
  }, [program, send, refresh]);

  const closePosition = useCallback(async (asset: Asset): Promise<string | null> => {
    const err = await send(() => program!.perps.closePosition(asset));
    if (!err) setTimeout(refresh, 1500);
    return err;
  }, [program, send, refresh]);

  return { positions, marks, reserve, busy, openPosition, closePosition, refresh };
}
