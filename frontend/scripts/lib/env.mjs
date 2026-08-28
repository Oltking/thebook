// Shared environment handling for every script that signs a transaction.
//
// Audit H-09: these scripts each defaulted `NODE_ADDRESS` to testnet while holding
// the mainnet admin seed, and loaded `frontend/.env` on top of the process
// environment. Running one without setting the variable sent a real admin action to
// the wrong chain, and a stray value in a dotfile could silently redirect one that
// was set correctly. Two rules fix both:
//
//   1. `NODE_ADDRESS` is REQUIRED. There is no default, so a signing script cannot
//      guess which chain it is on.
//   2. An explicitly-passed `NODE_ADDRESS` wins over anything in a .env file.
//
// Scripts that only read (no signing) may still use `loadEnv` on its own.

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const scriptsDir = resolve(here, '..');

/** Known Vara endpoints, for the confirmation banner and the mainnet guard. */
export const MAINNET_RPC = 'wss://rpc.vara.network';
export const TESTNET_RPC = 'wss://testnet.vara.network';

export function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

/**
 * Load the dotfiles while preserving explicitly-passed values.
 *
 * Returns `{ cliNode }` — whatever `NODE_ADDRESS` was set to on the command line,
 * before any file could overwrite it.
 */
export function loadEnv(files = ['.env', '.env.deploy']) {
  const cliNode = process.env.NODE_ADDRESS;
  for (const f of files) {
    const p = resolve(scriptsDir, '..', f);
    if (existsSync(p)) {
      try { process.loadEnvFile(p); } catch { /* ignore malformed dotfile */ }
    }
  }
  return { cliNode };
}

/**
 * Resolve the RPC endpoint for a script that signs. Exits with a clear message
 * rather than defaulting, and re-applies the CLI value over the dotfiles.
 */
export function requireNode({ cliNode } = {}) {
  const node = cliNode ?? process.env.NODE_ADDRESS;
  if (!node) {
    fail(
      'NODE_ADDRESS is required and has no default.\n' +
      `    Mainnet: NODE_ADDRESS=${MAINNET_RPC}\n` +
      `    Testnet: NODE_ADDRESS=${TESTNET_RPC}\n` +
      '    This script signs transactions; it will not guess which chain to sign on.',
    );
  }
  return node;
}

/** Require an environment variable, failing with the reason it is needed. */
export function requireEnv(name, why) {
  const v = process.env[name];
  if (!v) fail(`${name} is required${why ? ` (${why})` : ''}.`);
  return v;
}

/** Print which chain and program a signing script is about to act on. */
export function banner(title, fields) {
  const network = fields.node === MAINNET_RPC ? 'MAINNET' : fields.node === TESTNET_RPC ? 'testnet' : 'custom';
  console.log(`\n${title}  [${network}]`);
  for (const [k, v] of Object.entries(fields)) {
    console.log(`  ${k.padEnd(9)} ${v}`);
  }
  console.log('');
}
