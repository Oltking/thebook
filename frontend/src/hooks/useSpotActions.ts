// Write actions for the v1 spot CLOB and the token approvals they require.
// Users pay their own gas (no voucher in v1), matching the mainnet spot model.
import { useApi, useAccount } from '@gear-js/react-hooks';
import { useCallback, useState } from 'react';
import { web3FromSource } from '@polkadot/extension-dapp';
import { useSails } from './useSails';
import { VftProgram } from '../lib/vft';
import { PROGRAM_ID } from '../consts';

type Side = 'Buy' | 'Sell';

// A generic sign-send-await for any sails TransactionBuilder. Surfaces a program
// `err` result as a thrown Error so callers can show it.
async function run<T>(
  tx: { withAccount: (a: string, o: any) => any; signAndSend: () => Promise<{ response: () => Promise<T> }> },
  source: string,
  address: string,
): Promise<T> {
  const { signer } = await web3FromSource(source);
  await tx.withAccount(address, { signer }).calculateGas(true, 100);
  const { response } = await tx.signAndSend();
  const value = await response();
  if (value && typeof value === 'object' && 'err' in (value as any)) {
    throw new Error(JSON.stringify((value as any).err));
  }
  return value && typeof value === 'object' && 'ok' in (value as any) ? (value as any).ok : value;
}

export function useSpotActions() {
  const { program, account } = useSails();
  const { api } = useApi();
  const { account: acct } = useAccount();
  const [pending, setPending] = useState(false);

  const ready = !!program && !!account && !!api;

  const call = useCallback(
    async <T,>(build: () => any): Promise<T> => {
      if (!program || !account) throw new Error('Wallet not connected');
      setPending(true);
      try {
        return await run<T>(build(), account.meta.source, account.address);
      } finally {
        setPending(false);
      }
    },
    [program, account],
  );

  // Approve the DEX to pull `amount` of `token` (a VFT program id). Needed before an
  // order can escrow that token. `amount` is smallest-units (bigint).
  const approve = useCallback(
    async (token: string, amount: bigint): Promise<boolean> => {
      if (!api || !account) throw new Error('Wallet not connected');
      const vft = new VftProgram(api, token as `0x${string}`);
      setPending(true);
      try {
        return await run<boolean>(
          vft.vft.approve(PROGRAM_ID as `0x${string}`, amount),
          account.meta.source,
          account.address,
        );
      } finally {
        setPending(false);
      }
    },
    [api, account],
  );

  return {
    ready,
    pending,
    account: acct,
    approve,
    placeLimit: (pairId: bigint, side: Side, price: bigint, qty: bigint) =>
      call<bigint>(() => program!.spot.placeLimit(pairId, side, price, qty)),
    marketBuy: (pairId: bigint, qty: bigint, maxQuote: bigint) =>
      call<bigint>(() => program!.spot.marketBuy(pairId, qty, maxQuote)),
    marketSell: (pairId: bigint, qty: bigint) =>
      call<bigint>(() => program!.spot.marketSell(pairId, qty)),
    cancelOrder: (orderId: bigint) =>
      call<null>(() => program!.spot.cancelOrder(orderId)),
    withdraw: (token: string) =>
      call<bigint>(() => program!.spot.withdraw(token as `0x${string}`)),
  };
}
