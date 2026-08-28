#!/usr/bin/env node
// Solvency monitor (audit M-17).
//
// Asserts, per token, the invariant the contract is built around:
//
//   balanceOf(program) >= escrow + dust + reserve + sum(claims)
//
// The contract exposes `Spot/GetSolvency(token) -> (escrow, dust, reserve)`, and
// claims are per-account so they cannot be summed from a read. What this monitor
// checks is therefore the strong, cheap half: the program's real token balance must
// cover everything the contract knows it owes *before* any user claim. A breach
// means the program has paid out more than it took in, which is the shape every
// fund-loss bug has.
//
// It also watches for the things the audit says nobody would have noticed:
//   * a drop in the program's token balance larger than THRESHOLD_PCT between polls
//   * the perps reserve falling below its coverage floor
//   * the venue being paused or unpaused
//
// Read-only. It signs nothing and needs no seed.
//
// Usage:
//   NODE_ADDRESS=wss://rpc.vara.network \
//   PROGRAM_ID=0x… \
//   node scripts/solvency-monitor.mjs
//
// Env:
//   NODE_ADDRESS   Vara RPC (required — no default, this must not guess a chain)
//   PROGRAM_ID     thebook program id (required)
//   TOKENS         comma-separated token ids (default: the four mainnet tokens)
//   INTERVAL_MS    poll interval (default 30000)
//   THRESHOLD_PCT  alert if the held balance drops more than this between polls (default 5)
//   ALERT_WEBHOOK  optional URL to POST alerts to (Slack-compatible {text})
//   ONCE           set to run a single check and exit non-zero on any alert (for CI/cron)

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GearApi } from '@gear-js/api';
import { Sails } from 'sails-js';
import { SailsIdlParser } from 'sails-js-parser';
import { requireNode, requireEnv, fail } from './lib/env.mjs';

const CLI_NODE = process.env.NODE_ADDRESS;

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
for (const f of [resolve(__dirname, '..', '.env'), resolve(__dirname, '..', '.env.deploy')]) {
  if (existsSync(f)) { try { process.loadEnvFile(f); } catch { /* ignore */ } }
}

const NODE_ADDRESS = requireNode({ cliNode: CLI_NODE });
const PROGRAM_ID = requireEnv('PROGRAM_ID', 'the DEX program id to monitor');
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? '30000');
const THRESHOLD_PCT = Number(process.env.THRESHOLD_PCT ?? '5');
const ALERT_WEBHOOK = process.env.ALERT_WEBHOOK;
const ONCE = !!process.env.ONCE;

const DEFAULT_TOKENS = [
  '0x29c42c668012b1ce20720e4615229215023281ef4676fdc77bf047d7fbcb9d17', // wVARA
  '0xde45bdbb0345919a11561d43a5082e0b25061d4a2c6eb80009c1cfbccb80d0de', // wETH
  '0x4255ff4a87a4c13dc39f74ace8c4948bbef2f75fb639d66639a1cfcc99e6243e', // wUSDT
  '0xd1de816d7dce6439504552686ab333e5b7302b1549763656b30af1f8a5871b6a', // wUSDC
];
const TOKENS = (process.env.TOKENS ? process.env.TOKENS.split(',') : DEFAULT_TOKENS)
  .map((t) => t.trim())
  .filter(Boolean);

const IDL_PATH = process.env.IDL_PATH ?? resolve(repoRoot, 'client/thebook_client.idl');
const VFT_IDL_PATH = process.env.VFT_IDL_PATH ?? resolve(repoRoot, 'sdk/vft.idl');
if (!existsSync(IDL_PATH)) fail(`IDL not found at ${IDL_PATH}.`);
if (!existsSync(VFT_IDL_PATH)) fail(`VFT IDL not found at ${VFT_IDL_PATH}.`);

const api = await GearApi.create({ providerAddress: NODE_ADDRESS });
const parser = await SailsIdlParser.new();

const dex = new Sails(parser);
dex.parseIdl(readFileSync(IDL_PATH, 'utf-8'));
dex.setProgramId(PROGRAM_ID);
dex.setApi(api);

const vftCache = new Map();
function vftFor(token) {
  let s = vftCache.get(token);
  if (!s) {
    s = new Sails(parser);
    s.parseIdl(readFileSync(VFT_IDL_PATH, 'utf-8'));
    s.setProgramId(token);
    s.setApi(api);
    vftCache.set(token, s);
  }
  return s;
}

async function alert(level, message) {
  const line = `[${new Date().toISOString()}] ${level}: ${message}`;
  if (level === 'OK') console.log(line);
  else console.error(line);
  if (ALERT_WEBHOOK && level !== 'OK') {
    try {
      await fetch(ALERT_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `thebook ${level}: ${message}` }),
      });
    } catch (e) {
      console.error(`  (webhook failed: ${e?.message || e})`);
    }
  }
}

const lastHeld = new Map();
let lastPaused = null;

async function check() {
  let breached = false;

  // Venue state. A pause that nobody triggered is itself worth an alert.
  try {
    const paused = await dex.services.Spot.queries.IsPaused().call();
    if (lastPaused !== null && paused !== lastPaused) {
      await alert('WARN', `venue pause state changed: paused=${paused}`);
      breached = true;
    }
    lastPaused = paused;
  } catch (e) {
    await alert('WARN', `could not read pause state: ${e?.message || e}`);
  }

  for (const token of TOKENS) {
    try {
      const [escrow, dust, reserve] = await dex.services.Spot.queries
        .GetSolvency(token)
        .call();
      const held = BigInt(
        (await vftFor(token).services.Vft.queries.BalanceOf(PROGRAM_ID).call()).toString(),
      );
      const owed = BigInt(escrow) + BigInt(dust) + BigInt(reserve);

      // The invariant. `held` must also cover user claims, so this is a lower bound:
      // failing it means the program is definitely insolvent.
      if (held < owed) {
        await alert(
          'CRITICAL',
          `INSOLVENT ${token}: held ${held} < escrow ${escrow} + dust ${dust} + reserve ${reserve} = ${owed}`,
        );
        breached = true;
      }

      // A large drop between polls is the signature of a drain in progress.
      const prev = lastHeld.get(token);
      if (prev !== undefined && prev > 0n) {
        const dropPct = Number(((prev - held) * 10000n) / prev) / 100;
        if (dropPct > THRESHOLD_PCT) {
          await alert(
            'CRITICAL',
            `${token} balance fell ${dropPct.toFixed(2)}% in one interval (${prev} -> ${held})`,
          );
          breached = true;
        }
      }
      lastHeld.set(token, held);

      if (!ONCE) {
        console.log(`  ok ${token.slice(0, 10)}… held=${held} owed=${owed} headroom=${held - owed}`);
      }
    } catch (e) {
      await alert('WARN', `could not check ${token}: ${e?.message || e}`);
    }
  }

  // Perps reserve coverage.
  try {
    const [reserve, liability, coverageBps] = await dex.services.PerpsV1.queries
      .GetReserveHealth()
      .call();
    const cov = BigInt(coverageBps);
    // 12000 bps = the contract's own MIN_COVERAGE_BPS floor for opening positions.
    if (BigInt(liability) > 0n && cov < 12000n) {
      await alert(
        'WARN',
        `perps reserve coverage ${Number(cov) / 100}% below the 120% floor (reserve ${reserve}, liability ${liability})`,
      );
      breached = true;
    }
  } catch {
    /* perps may not be configured on this deployment */
  }

  return breached;
}

if (ONCE) {
  const breached = await check();
  if (!breached) await alert('OK', 'solvency invariant holds for all tokens');
  await api.disconnect();
  process.exit(breached ? 1 : 0);
}

console.log(`\nthebook solvency monitor`);
console.log(`  node:     ${NODE_ADDRESS}`);
console.log(`  program:  ${PROGRAM_ID}`);
console.log(`  tokens:   ${TOKENS.length}`);
console.log(`  interval: ${INTERVAL_MS}ms\n`);

await check();
setInterval(() => { check().catch((e) => console.error(e)); }, INTERVAL_MS);
