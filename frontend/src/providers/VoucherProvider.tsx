import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAccount } from '@gear-js/react-hooks';
import { web3FromSource } from '@polkadot/extension-dapp';
import { u8aToHex, stringToU8a } from '@polkadot/util';

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
 * Requests a gasless voucher for the connected account and makes it available
 * app-wide. Degrades silently to self-paid gas when the backend is absent (dev),
 * unconfigured, or rate-limiting — the UI never blocks on it.
 *
 * Issuance is a two-step challenge: the endpoint hands out a nonce, the wallet
 * signs it, and the endpoint verifies the signature before spending anything. That
 * proves control of the address, without which per-address rate limits are
 * meaningless — addresses are free to generate (audit H-01).
 *
 * The signature is over a server-issued nonce string, not a transaction. It moves
 * nothing and authorises nothing beyond "issue this account a gas voucher".
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
        // 1 · Ask for a challenge.
        const challengeRes = await fetch(`/api/voucher?account=${encodeURIComponent(account.decodedAddress)}`);
        if (!challengeRes.ok) return;
        const challenge = await challengeRes.json() as { enabled?: boolean; nonce?: string };
        if (!active) return;
        setEnabled(!!challenge.enabled);
        if (!challenge.enabled || !challenge.nonce) return;

        // 2 · Sign it with the connected wallet.
        const injector = await web3FromSource(account.meta.source);
        const signRaw = injector.signer?.signRaw;
        if (!signRaw) return; // wallet can't sign raw payloads; fall back to self-paid gas
        const { signature } = await signRaw({
          address: account.address,
          data: u8aToHex(stringToU8a(challenge.nonce)),
          type: 'bytes',
        });
        if (!active) return;

        // 3 · Redeem it.
        const res = await fetch('/api/voucher', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account: account.decodedAddress, nonce: challenge.nonce, signature }),
        });
        if (!res.ok) return; // rate-limited or unavailable — self-paid gas
        const data = await res.json() as { enabled?: boolean; voucherId?: string };
        if (!active) return;
        setEnabled(!!data.enabled);
        setVoucherId(data.voucherId ?? null);
      } catch {
        /* no backend in dev, offline, or the user declined to sign — self-paid gas */
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
