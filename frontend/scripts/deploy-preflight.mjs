#!/usr/bin/env node
// Read-only preflight for a mainnet deploy.
//
// Checks everything that can fail a deploy BEFORE any transaction is signed:
// the admin account exists and can pay for gas, the WASM and IDL are present and
// current, the token programs are real and report the decimals we are about to
// claim at listing (the contract verifies these and rejects a mismatch), and the
// keeper account is well-formed and distinct from the admin.
//
// Signs nothing. Safe to run repeatedly.
//
// Usage (from frontend/):
//   NODE_ADDRESS=wss://rpc.vara.network KEEPER=<ss58-or-hex> node scripts/deploy-preflight.mjs

import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GearApi } from '@gear-js/api';
import { Keyring } from '@polkadot/api';
import { u8aToHex } from '@polkadot/util';
import { decodeAddress } from '@polkadot/util-crypto';
import { waitReady } from '@polkadot/wasm-crypto';
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
const SEED = requireEnv('VARA_SEED', 'the admin seed that will sign the deploy');
const KEEPER = process.env.KEEPER;
const DEX_WASM = process.env.DEX_WASM ?? resolve(repoRoot, 'target/wasm32-gear/release/thebook.opt.wasm');
const IDL_PATH = process.env.IDL_PATH ?? resolve(repoRoot, 'client/thebook_client.idl');
const VFT_IDL = resolve(repoRoot, 'sdk/vft.idl');

const T = {
  wVARA: { addr: '0x29c42c668012b1ce20720e4615229215023281ef4676fdc77bf047d7fbcb9d17', dec: 12 },
  wETH: { addr: '0xde45bdbb0345919a11561d43a5082e0b25061d4a2c6eb80009c1cfbccb80d0de', dec: 18 },
  wUSDT: { addr: '0x4255ff4a87a4c13dc39f74ace8c4948bbef2f75fb639d66639a1cfcc99e6243e', dec: 6 },
  wUSDC: { addr: '0xd1de816d7dce6439504552686ab333e5b7302b1549763656b30af1f8a5871b6a', dec: 6 },
};

const VARA = 1_000_000_000_000n; // 12 decimals
/** Rough floor for deploy + 4 listings + perps wiring, with headroom. */
const MIN_VARA = 30n * VARA;

let problems = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { problems += 1; console.log(`  ✗ ${m}`); };
const warn = (m) => console.log(`  ! ${m}`);

console.log('\nthebook deploy preflight (read-only)');
console.log(`  node: ${NODE_ADDRESS}\n`);

// ── Artefacts ──
console.log('── Build artefacts ──────────────────────────────────');
if (!existsSync(DEX_WASM)) {
  bad(`WASM missing at ${DEX_WASM} — run: cargo build --release`);
} else {
  const w = statSync(DEX_WASM);
  ok(`WASM present (${(w.size / 1024).toFixed(0)} KB, built ${w.mtime.toISOString()})`);
  if (existsSync(IDL_PATH) && statSync(IDL_PATH).mtimeMs > w.mtimeMs + 60_000) {
    warn('IDL is newer than the WASM — rebuild so they match');
  }
}
if (!existsSync(IDL_PATH)) bad(`IDL missing at ${IDL_PATH}`); else ok('IDL present');

// The IDL must describe the remediated program, not an older build.
if (existsSync(IDL_PATH)) {
  const idl = readFileSync(IDL_PATH, 'utf-8');
  // `service Amm` is NOT banned: the legacy virtual-balance AMM was deleted with
  // C-02 and a real one built in its place. What must stay gone are the
  // virtual-balance entry points themselves.
  for (const banned of ['service Orderbook', 'CallAgentService', 'SeedHouse']) {
    if (idl.includes(banned)) bad(`IDL still contains '${banned}' — wrong build`);
  }
  for (const needed of [
    'AcceptAdmin', 'SetPaused', 'GetSolvency', 'MarketSell',
    'service Amm', 'AddLiquidity', 'min_shares',   // the real AMM
    'GetConfig',                                    // perps collateral read
  ]) {
    if (!idl.includes(needed)) bad(`IDL missing '${needed}' — stale build`);
  }
  if (idl.includes('service Spot') && !idl.includes('service Orderbook')) {
    ok('IDL is the remediated build (no legacy services)');
  }
}
console.log('');

await waitReady();
const api = await GearApi.create({ providerAddress: NODE_ADDRESS });

// ── Accounts ──
console.log('── Accounts ─────────────────────────────────────────');
const keyring = new Keyring({ type: 'sr25519' });
const admin = keyring.addFromUri(SEED.trim());
const adminHex = u8aToHex(admin.addressRaw);
console.log(`  admin:  ${admin.address}`);
console.log(`          ${adminHex}`);

const { data: bal } = await api.query.system.account(admin.address);
const free = bal.free.toBigInt();
console.log(`  balance: ${(Number(free) / Number(VARA)).toFixed(4)} VARA`);
if (free < MIN_VARA) {
  bad(`admin holds under ${MIN_VARA / VARA} VARA — top it up before deploying`);
} else {
  ok('admin can cover deploy gas');
}

if (!KEEPER) {
  bad('KEEPER not set — required, and must be a separate account from admin');
} else {
  try {
    const keeperHex = u8aToHex(decodeAddress(KEEPER));
    if (keeperHex === adminHex) {
      bad('KEEPER is the admin account — it must be a dedicated key');
    } else {
      ok(`keeper is a distinct account (${keeperHex.slice(0, 10)}…)`);
      const { data: kb } = await api.query.system.account(KEEPER);
      const kfree = kb.free.toBigInt();
      console.log(`  keeper balance: ${(Number(kfree) / Number(VARA)).toFixed(4)} VARA`);
      if (kfree === 0n) {
        warn('keeper has no VARA — it needs gas to publish marks (fund it before starting the worker)');
      }
    }
  } catch {
    bad(`KEEPER is not a valid address: ${KEEPER}`);
  }
}
console.log('');

// ── Token programs ──
console.log('── Token programs ───────────────────────────────────');
const parser = await SailsIdlParser.new();
for (const [sym, t] of Object.entries(T)) {
  try {
    const vft = new Sails(parser);
    vft.parseIdl(readFileSync(VFT_IDL, 'utf-8'));
    vft.setProgramId(t.addr);
    vft.setApi(api);
    const dec = await vft.services.VftMetadata.queries.Decimals().call();
    if (Number(dec) !== t.dec) {
      bad(`${sym} reports ${dec} decimals, we list ${t.dec} — listing WILL be rejected`);
    } else {
      ok(`${sym} live, ${dec} decimals as expected`);
    }
  } catch (e) {
    bad(`${sym} unreachable: ${String(e?.message || e).slice(0, 70)}`);
  }
}
console.log('');

console.log(problems === 0
  ? '  ✓ preflight clean — safe to deploy\n'
  : `  ✗ ${problems} problem(s) — fix before deploying\n`);

await api.disconnect();
process.exit(problems === 0 ? 0 : 1);
