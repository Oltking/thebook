import { useCallback, useState } from 'react';
import { useSails } from './useSails';
import { web3FromSource } from '@polkadot/extension-dapp';
import { useVoucher } from '../providers/VoucherProvider';
import { TokenProgram } from '../lib/token';
import { TOKENS, TOKENS_CONFIGURED, PROGRAM_ID, type TokenMeta } from '../consts';

export type VaultStep =
  | 'idle'
  | 'claiming'
  | 'approving'
  | 'depositing'
  | 'withdrawing'
  | 'done';

function tokenFor(api: any, kind: TokenKind): { meta: TokenMeta; token: TokenProgram } {
  const meta = TOKENS.find((t) => t.kind === kind);
  if (!meta) throw new Error(`Unknown token kind ${kind}`);
  return { meta, token: new TokenProgram(api, meta.programId) };
}

/**
 * The real-token onboarding + custody flow: claim wrapped test tokens from each
 * faucet, approve the DEX, and deposit into the vault — plus per-token deposit and
 * withdraw. Every action is a normal user-signed extrinsic; wiring a gasless
 * voucher backend here would sponsor the claim/deposit gas without changing the UI.
 */
export function useVault() {
  const { program, account, isReady } = useSails();
  const { apply: applyVoucher } = useVoucher();
  const [step, setStep] = useState<VaultStep>('idle');
  const [busy, setBusy] = useState(false);

  const send = useCallback(
    async (buildTx: () => any) => {
      if (!account) throw new Error('Wallet not ready');
      const { signer } = await web3FromSource(account.meta.source);
      const tx = buildTx();
      await applyVoucher(tx.withAccount(account.address, { signer })).calculateGas(true, 100);
      const { response } = await tx.signAndSend();
      return response();
    },
    [account, applyVoucher],
  );

  /** Claim `amount` from a token's faucet, approve the DEX, and deposit it. */
  const claimAndDeposit = useCallback(
    async (kind: TokenKind, amount: bigint): Promise<string | null> => {
      if (!program || !account || !isReady) return 'Wallet not ready';
      if (!TOKENS_CONFIGURED) return 'Token programs are not configured yet';
      setBusy(true);
      try {
        const { token } = tokenFor(program.api, kind);
        const already = await token
          .hasClaimed(account.decodedAddress)
          .call()
          .catch(() => false);

        if (!already) {
          setStep('claiming');
          await send(() => token.claim());
        }
        const allowed = await token
          .allowance(account.decodedAddress, PROGRAM_ID)
          .call()
          .then((a) => BigInt(a?.toString() || '0'))
          .catch(() => 0n);
        if (allowed < amount) {
          setStep('approving');
          await send(() => token.approve(PROGRAM_ID, amount.toString()));
        }
        setStep('depositing');
        await send(() => program.orderbook.deposit(kind, amount.toString()));
        setStep('done');
        return null;
      } catch (e: any) {
        console.error('claimAndDeposit failed:', e);
        setStep('idle');
        return e?.message || String(e);
      } finally {
        setBusy(false);
      }
    },
    [program, account, isReady, send],
  );

  /** Deposit already-held tokens: approve then deposit. */
  const deposit = useCallback(
    async (kind: TokenKind, amount: bigint): Promise<string | null> => {
      if (!program || !account || !isReady) return 'Wallet not ready';
      if (!TOKENS_CONFIGURED) return 'Token programs are not configured yet';
      setBusy(true);
      try {
        const { token } = tokenFor(program.api, kind);
        const allowed = await token
          .allowance(account.decodedAddress, PROGRAM_ID)
          .call()
          .then((a) => BigInt(a?.toString() || '0'))
          .catch(() => 0n);
        if (allowed < amount) {
          setStep('approving');
          await send(() => token.approve(PROGRAM_ID, amount.toString()));
        }
        setStep('depositing');
        await send(() => program.orderbook.deposit(kind, amount.toString()));
        setStep('done');
        return null;
      } catch (e: any) {
        console.error('deposit failed:', e);
        setStep('idle');
        return e?.message || String(e);
      } finally {
        setBusy(false);
      }
    },
    [program, account, isReady, send],
  );

  const withdraw = useCallback(
    async (kind: TokenKind, amount: bigint): Promise<string | null> => {
      if (!program || !account || !isReady) return 'Wallet not ready';
      setBusy(true);
      try {
        setStep('withdrawing');
        await send(() => program.orderbook.withdraw(kind, amount.toString()));
        setStep('done');
        return null;
      } catch (e: any) {
        console.error('withdraw failed:', e);
        setStep('idle');
        return e?.message || String(e);
      } finally {
        setBusy(false);
      }
    },
    [program, account, isReady, send],
  );

  return { claimAndDeposit, deposit, withdraw, step, busy };
}
