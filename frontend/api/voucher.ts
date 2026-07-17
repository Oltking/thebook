import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GearApi, decodeAddress } from '@gear-js/api';
import { Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';

/**
 * Gasless voucher issuer.
 *
 * POST { account } → issues (or reuses) a Vara gas voucher for that account,
 * scoped to the thebook program, funded by a server-held sponsor account. The
 * frontend then sends transactions `.withVoucher(voucherId)` so users and agents
 * never need their own VARA for gas.
 *
 * Inert until SPONSOR_SEED is set — returns { enabled:false } so the client
 * cleanly falls back to self-paid gas (mirrors api/agent.ts's no-key behavior).
 *
 * Env:
 *   SPONSOR_SEED   — mnemonic/URI of a funded testnet account (server secret)
 *   NODE_ADDRESS   — Vara RPC ws endpoint (default: testnet)
 *   PROGRAM_ID     — thebook program id (default: the deployed testnet id)
 *   VOUCHER_VARA   — voucher balance in whole VARA (default: 5)
 *   VOUCHER_BLOCKS — voucher validity in blocks (default: 1_000_000 ≈ weeks)
 */

const DEFAULT_NODE = 'wss://testnet.vara.network';
const DEFAULT_PROGRAM = '0x27f2fd8412b247f4db25af6d3b75303612818446b3c0cc635cf3b79747bceccd';
const VARA = 1_000_000_000_000n; // 12 decimals

let apiPromise: Promise<GearApi> | null = null;
function getApi(node: string): Promise<GearApi> {
  if (!apiPromise) apiPromise = GearApi.create({ providerAddress: node });
  return apiPromise;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const seed = process.env.SPONSOR_SEED;
  if (!seed) { res.status(200).json({ enabled: false, reason: 'no-sponsor' }); return; }

  const node = process.env.NODE_ADDRESS || DEFAULT_NODE;
  const programId = (process.env.PROGRAM_ID || DEFAULT_PROGRAM) as `0x${string}`;
  const value = BigInt(process.env.VOUCHER_VARA || '5') * VARA;
  const duration = Number(process.env.VOUCHER_BLOCKS || '1000000');

  const body = (req.body || {}) as { account?: string };
  const account = body.account;
  if (!account || typeof account !== 'string') { res.status(400).json({ error: 'account required' }); return; }

  let spender: string;
  try {
    spender = decodeAddress(account); // accepts SS58 or 0x-hex, returns hex actor id
  } catch {
    res.status(400).json({ error: 'invalid account address' }); return;
  }

  try {
    const api = await getApi(node);
    await cryptoWaitReady();
    const keyring = new Keyring({ type: 'sr25519' });
    const sponsor = seed.trim().startsWith('0x') || seed.includes(' ')
      ? keyring.addFromMnemonic(seed.trim())
      : keyring.addFromUri(seed.trim());

    // Reuse an existing, program-scoped voucher if the spender already has one.
    try {
      const existing = await api.voucher.getAllForAccount(spender, programId);
      const ids = Object.keys(existing || {});
      if (ids.length > 0) {
        res.status(200).json({ enabled: true, voucherId: ids[0], reused: true });
        return;
      }
    } catch { /* no existing voucher — issue a fresh one */ }

    // Clamp validity to the runtime's allowed voucher-duration window.
    const dur = Math.max(api.voucher.minDuration, Math.min(duration, api.voucher.maxDuration));

    const { extrinsic, voucherId } = await api.voucher.issue(
      spender,
      value,
      dur,
      [programId],
      false, // no code uploading
    );

    await new Promise<void>((resolve, reject) => {
      extrinsic.signAndSend(sponsor, ({ status, events, dispatchError }) => {
        if (dispatchError) { reject(new Error(dispatchError.toString())); return; }
        if (status.isInBlock || status.isFinalized) {
          const failed = events.find(({ event }) => api.events.system.ExtrinsicFailed.is(event));
          if (failed) reject(new Error('voucher issuance failed on-chain'));
          else resolve();
        }
      }).catch(reject);
    });

    res.status(200).json({ enabled: true, voucherId, reused: false });
  } catch (e: any) {
    res.status(200).json({ enabled: true, error: String(e?.message || e).slice(0, 300) });
  }
}
