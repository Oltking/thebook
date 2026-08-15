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

const DEFAULT_NODE = 'wss://rpc.vara.network';
const DEFAULT_PROGRAM = '0x7c5dbc8a85a8526c3a0c4fe98f0fb286782849c4d130ff28d6b7b30d157c2484';
// The voucher must also cover the token VFT programs, because a spot order's `approve`
// tx is sent to the token program (not the DEX). Without these, approvals aren't gasless.
const TOKEN_PROGRAMS = [
  '0x29c42c668012b1ce20720e4615229215023281ef4676fdc77bf047d7fbcb9d17', // wVARA
  '0xde45bdbb0345919a11561d43a5082e0b25061d4a2c6eb80009c1cfbccb80d0de', // wETH
  '0x4255ff4a87a4c13dc39f74ace8c4948bbef2f75fb639d66639a1cfcc99e6243e', // wUSDT
  '0xd1de816d7dce6439504552686ab333e5b7302b1549763656b30af1f8a5871b6a', // wUSDC
];
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
  // Per-account gas allowance. Kept small on purpose: a voucher pays transaction FEES
  // ONLY (never the sponsor's balance), and this caps how much gas any single account
  // can consume before it must be re-issued. Vara gas is cheap, so 1 VARA is many trades.
  const value = BigInt(process.env.VOUCHER_VARA || '1') * VARA;
  const duration = Number(process.env.VOUCHER_BLOCKS || '216000'); // ~30 days at 12s blocks

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
      [programId, ...TOKEN_PROGRAMS], // DEX + token programs (approve is on the token)
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
