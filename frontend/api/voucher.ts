import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GearApi, decodeAddress } from '@gear-js/api';
import { Keyring } from '@polkadot/api';
import { cryptoWaitReady, signatureVerify } from '@polkadot/util-crypto';

/**
 * Gasless voucher issuer.
 *
 * A voucher pays transaction FEES ONLY. It never grants access to the sponsor's
 * balance and is scoped to the DEX program plus the four token programs (a spot
 * order's `approve` is sent to the token program, not the DEX, so approvals are not
 * gasless without them).
 *
 * ## Two-step, because addresses are free
 *
 * The endpoint used to accept any address and issue a voucher, with no auth, no rate
 * limit, and no origin check — one HTTP request per voucher, and addresses cost
 * nothing to generate, so draining the sponsor was a for-loop (audit H-01). Issuance
 * now requires proof of control of the address:
 *
 *   GET  /api/voucher?account=<addr>  → { nonce }         (stored, 5 min TTL)
 *   POST /api/voucher { account, nonce, signature }       → { voucherId }
 *
 * The signature is verified against the account's own public key, so a caller can
 * only obtain vouchers for keys they actually hold. On top of that: per-address and
 * per-IP rate limits in durable storage, a global daily issuance cap, and CORS
 * restricted to the app's own origin.
 *
 * Inert until SPONSOR_SEED is set — returns { enabled:false } so the client cleanly
 * falls back to self-paid gas. Removing SPONSOR_SEED from the environment is the
 * supported kill switch.
 *
 * Env:
 *   SPONSOR_SEED    — mnemonic/URI of the funded sponsor account (server secret)
 *   NODE_ADDRESS    — Vara RPC ws endpoint (REQUIRED; no default, audit H-09)
 *   PROGRAM_ID      — thebook program id (REQUIRED; no default)
 *   ALLOWED_ORIGIN  — comma-separated origins allowed to call this (required in prod)
 *   VOUCHER_VARA    — voucher balance in whole VARA (default: 1)
 *   VOUCHER_BLOCKS  — voucher validity in blocks (default: 216000 ≈ 30 days)
 *   VOUCHER_DAILY_MAX — max vouchers issued per UTC day (default: 200)
 *   KV_REST_API_URL / KV_REST_API_TOKEN — durable storage for nonces + rate limits
 */

// The voucher must also cover the token VFT programs, because a spot order's
// `approve` tx is sent to the token program (not the DEX).
const TOKEN_PROGRAMS = [
  '0x29c42c668012b1ce20720e4615229215023281ef4676fdc77bf047d7fbcb9d17', // wVARA
  '0xde45bdbb0345919a11561d43a5082e0b25061d4a2c6eb80009c1cfbccb80d0de', // wETH
  '0x4255ff4a87a4c13dc39f74ace8c4948bbef2f75fb639d66639a1cfcc99e6243e', // wUSDT
  '0xd1de816d7dce6439504552686ab333e5b7302b1549763656b30af1f8a5871b6a', // wUSDC
];
const VARA = 1_000_000_000_000n; // 12 decimals

/** How long a challenge nonce stays valid. */
const NONCE_TTL_S = 300;
/** Minimum gap between vouchers for one address, and for one IP. */
const ADDRESS_COOLDOWN_S = 24 * 60 * 60;
const IP_COOLDOWN_S = 60;
/** Max voucher issuance attempts from one IP per hour. */
const IP_HOURLY_MAX = 10;

/* ── Durable storage (Vercel KV REST) ──────────────────────────────────────────── */

function kvConfig(): { url: string; token: string } | null {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  return url && token ? { url, token } : null;
}

async function kvGet(key: string): Promise<string | null> {
  const cfg = kvConfig();
  if (!cfg) return null;
  try {
    const res = await fetch(`${cfg.url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: string | null };
    return json.result ?? null;
  } catch {
    return null;
  }
}

async function kvSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  const cfg = kvConfig();
  if (!cfg) return;
  try {
    await fetch(`${cfg.url}/set/${encodeURIComponent(key)}?EX=${ttlSeconds}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'text/plain' },
      body: value,
    });
  } catch {
    /* storage unavailable — the caller decides whether to fail closed */
  }
}

async function kvDel(key: string): Promise<void> {
  const cfg = kvConfig();
  if (!cfg) return;
  try {
    await fetch(`${cfg.url}/del/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
  } catch {
    /* best effort */
  }
}

/** Increment a counter with a TTL, returning the new value. */
async function kvIncr(key: string, ttlSeconds: number): Promise<number> {
  const cfg = kvConfig();
  if (!cfg) return 0;
  try {
    const res = await fetch(`${cfg.url}/incr/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    if (!res.ok) return 0;
    const json = (await res.json()) as { result?: number };
    const n = json.result ?? 0;
    if (n === 1) await fetch(`${cfg.url}/expire/${encodeURIComponent(key)}/${ttlSeconds}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    return n;
  } catch {
    return 0;
  }
}

/* ── Helpers ───────────────────────────────────────────────────────────────────── */

function allowedOrigins(): string[] {
  return (process.env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

/** Apply CORS for the app's own origin only, and report whether the caller passes. */
function applyCors(req: VercelRequest, res: VercelResponse): boolean {
  const allowed = allowedOrigins();
  const origin = String(req.headers.origin || '');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  // With no allow-list configured, only same-origin (no Origin header) callers pass.
  if (allowed.length === 0) return !origin;
  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    return true;
  }
  return !origin;
}

function clientIp(req: VercelRequest): string {
  const fwd = req.headers['x-forwarded-for'];
  const raw = Array.isArray(fwd) ? fwd[0] : fwd;
  return (raw || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

let apiPromise: Promise<GearApi> | null = null;
/**
 * Cache the connection, but drop the cached promise when it rejects or the
 * connection dies — a permanently cached broken promise wedged the function until
 * the instance recycled (audit L-09).
 */
function getApi(node: string): Promise<GearApi> {
  if (!apiPromise) {
    apiPromise = GearApi.create({ providerAddress: node })
      .then((api) => {
        api.on('disconnected', () => { apiPromise = null; });
        api.on('error', () => { apiPromise = null; });
        return api;
      })
      .catch((e) => {
        apiPromise = null;
        throw e;
      });
  }
  return apiPromise;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]);
}

/* ── Handler ───────────────────────────────────────────────────────────────────── */

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const originOk = applyCors(req, res);

  if (req.method === 'OPTIONS') { res.status(originOk ? 200 : 403).end(); return; }
  if (!originOk) { res.status(403).json({ error: 'origin not allowed' }); return; }

  const seed = process.env.SPONSOR_SEED;
  if (!seed) { res.status(200).json({ enabled: false, reason: 'no-sponsor' }); return; }

  // Step 1: hand out a challenge to sign.
  if (req.method === 'GET') {
    const account = String(req.query.account || '');
    let spender: string;
    try {
      spender = decodeAddress(account);
    } catch {
      res.status(400).json({ error: 'invalid account address' });
      return;
    }
    const nonce = `thebook-voucher:${utcDay()}:${crypto.randomUUID()}`;
    await kvSet(`voucher:nonce:${spender}`, nonce, NONCE_TTL_S);
    res.status(200).json({ enabled: true, nonce, expiresIn: NONCE_TTL_S });
    return;
  }

  if (req.method !== 'POST') { res.status(405).json({ error: 'GET or POST only' }); return; }

  if (!kvConfig()) {
    // Fail closed: without durable storage there is no rate limit and no nonce
    // store, which is the exact configuration the audit found being abused.
    res.status(503).json({ enabled: false, reason: 'rate-limit-store-unavailable' });
    return;
  }

  const node = process.env.NODE_ADDRESS;
  const programId = process.env.PROGRAM_ID as `0x${string}` | undefined;
  if (!node || !programId) {
    res.status(500).json({ enabled: false, reason: 'misconfigured: NODE_ADDRESS and PROGRAM_ID are required' });
    return;
  }

  const value = BigInt(process.env.VOUCHER_VARA || '1') * VARA;
  const duration = Number(process.env.VOUCHER_BLOCKS || '216000');
  const dailyMax = Number(process.env.VOUCHER_DAILY_MAX || '200');

  const body = (req.body || {}) as { account?: string; nonce?: string; signature?: string };
  if (typeof body.account !== 'string' || typeof body.nonce !== 'string' || typeof body.signature !== 'string') {
    res.status(400).json({ error: 'account, nonce and signature are required' });
    return;
  }

  let spender: string;
  try {
    spender = decodeAddress(body.account);
  } catch {
    res.status(400).json({ error: 'invalid account address' });
    return;
  }

  // Per-IP limits first: they are the cheapest to check and the ones that stop a
  // scripted loop before it costs anything.
  const ip = clientIp(req);
  const ipHits = await kvIncr(`voucher:ip:h:${ip}`, 3600);
  if (ipHits > IP_HOURLY_MAX) {
    res.status(429).json({ error: 'rate limited' });
    return;
  }
  if (await kvGet(`voucher:ip:c:${ip}`)) {
    res.status(429).json({ error: 'rate limited' });
    return;
  }

  // Proof of control: the nonce we issued, signed by that account's key.
  const stored = await kvGet(`voucher:nonce:${spender}`);
  if (!stored || stored !== body.nonce) {
    res.status(400).json({ error: 'unknown or expired nonce — request a challenge first' });
    return;
  }
  await cryptoWaitReady();
  let verified = false;
  try {
    verified = signatureVerify(body.nonce, body.signature, spender).isValid;
  } catch {
    verified = false;
  }
  if (!verified) {
    res.status(401).json({ error: 'signature does not match the account' });
    return;
  }
  // One-shot: a nonce cannot be replayed.
  await kvDel(`voucher:nonce:${spender}`);

  if (await kvGet(`voucher:addr:${spender}`)) {
    res.status(429).json({ error: 'a voucher was already issued for this account today' });
    return;
  }

  const issuedToday = await kvIncr(`voucher:day:${utcDay()}`, 90000);
  if (issuedToday > dailyMax) {
    res.status(429).json({ error: 'daily issuance cap reached' });
    return;
  }

  try {
    const api = await withTimeout(getApi(node), 15_000, 'rpc connect');

    const keyring = new Keyring({ type: 'sr25519' });
    const trimmed = seed.trim();
    // A 0x-prefixed value is a raw seed for addFromUri, never a mnemonic — routing
    // it to addFromMnemonic threw (audit L-09).
    const sponsor = trimmed.includes(' ')
      ? keyring.addFromMnemonic(trimmed)
      : keyring.addFromUri(trimmed);

    // Reuse an existing, program-scoped voucher if the spender already has one.
    try {
      const existing = await api.voucher.getAllForAccount(spender, programId);
      const ids = Object.keys(existing || {});
      if (ids.length > 0) {
        res.status(200).json({ enabled: true, voucherId: ids[0], reused: true });
        return;
      }
    } catch { /* no existing voucher — issue a fresh one */ }

    const dur = Math.max(api.voucher.minDuration, Math.min(duration, api.voucher.maxDuration));

    const { extrinsic, voucherId } = await api.voucher.issue(
      spender,
      value,
      dur,
      [programId, ...TOKEN_PROGRAMS], // DEX + token programs (approve is on the token)
      false, // no code uploading
    );

    await withTimeout(
      new Promise<void>((resolve, reject) => {
        extrinsic.signAndSend(sponsor, ({ status, events, dispatchError }) => {
          if (dispatchError) { reject(new Error(dispatchError.toString())); return; }
          if (status.isInBlock || status.isFinalized) {
            const failed = events.find(({ event }) => api.events.system.ExtrinsicFailed.is(event));
            if (failed) reject(new Error('voucher issuance failed on-chain'));
            else resolve();
          }
        }).catch(reject);
      }),
      60_000,
      'voucher issuance',
    );

    // Only record the cooldowns once issuance actually succeeded.
    await kvSet(`voucher:addr:${spender}`, '1', ADDRESS_COOLDOWN_S);
    await kvSet(`voucher:ip:c:${ip}`, '1', IP_COOLDOWN_S);

    res.status(200).json({ enabled: true, voucherId, reused: false });
  } catch (e: any) {
    // Failures are reported as failures. Returning 200 with enabled:true made every
    // client treat an outage as a working voucher (audit L-09).
    res.status(502).json({ enabled: true, error: String(e?.message || e).slice(0, 300) });
  }
}
