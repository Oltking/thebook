import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAccount } from '@gear-js/react-hooks';

interface VoucherCtx {
  /** Active gas voucher id for the connected account, or null (self-paid gas). */
  voucherId: string | null;
  /** Whether the sponsor backend is configured (voucher issuance available). */
  enabled: boolean;
  /** Apply the voucher to a sails TransactionBuilder-like object, if we have one. */
  apply: <T extends { withVoucher: (id: string) => T }>(tx: T) => T;
}

const Ctx = createContext<VoucherCtx>({ voucherId: null, enabled: false, apply: (tx) => tx });

/**
 * Requests a gasless voucher for the connected account from /api/voucher and
 * makes it available app-wide. Degrades silently to self-paid gas when the
 * backend is absent (dev) or unconfigured - the UI never blocks on it.
 */
export function VoucherProvider({ children }: { children: ReactNode }) {
  const { account } = useAccount();
  const [voucherId, setVoucherId] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const requestedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!account) { setVoucherId(null); requestedFor.current = null; return; }
    if (requestedFor.current === account.decodedAddress) return;
    requestedFor.current = account.decodedAddress;

    let active = true;
    (async () => {
      try {
        const res = await fetch('/api/voucher', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account: account.decodedAddress }),
        });
        if (!res.ok) return;
        const data = await res.json() as { enabled?: boolean; voucherId?: string };
        if (!active) return;
        setEnabled(!!data.enabled);
        setVoucherId(data.voucherId ?? null);
      } catch {
        /* no backend in dev / offline - self-paid gas */
      }
    })();
    return () => { active = false; };
  }, [account]);

  const apply = <T extends { withVoucher: (id: string) => T }>(tx: T): T =>
    voucherId ? tx.withVoucher(voucherId) : tx;

  return <Ctx.Provider value={{ voucherId, enabled, apply }}>{children}</Ctx.Provider>;
}

export function useVoucher() {
  return useContext(Ctx);
}
