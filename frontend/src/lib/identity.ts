import type { SailsProgram } from './sails';

export interface AgentIdentity {
  name: string;
  strategy: AgentStrategy;
}

/** Normalize a LeaderEntry `id` ([u8;32], which may decode as hex string or byte
 *  array) into a lowercase 0x-hex address for comparison. */
function toHexAddr(id: unknown): string {
  if (typeof id === 'string') return id.toLowerCase();
  if (Array.isArray(id)) return '0x' + id.map((b) => Number(b).toString(16).padStart(2, '0')).join('');
  return String(id).toLowerCase();
}

/**
 * Resolve an account's agent identity robustly. Prefers the direct per-caller
 * query, but falls back to scanning the global leaderboard by address — so a
 * flaky/unsupported GetIdentity read can't make a real, registered agent look
 * like it doesn't exist.
 */
export async function resolveIdentity(
  program: SailsProgram,
  decodedAddress: string,
): Promise<AgentIdentity | null> {
  // 1 · direct query
  try {
    const id = await program.orderbook.getIdentity().withAddress(decodedAddress).call();
    if (id && Array.isArray(id) && id[0] != null) {
      return { name: String(id[0]), strategy: id[1] as AgentStrategy };
    }
  } catch { /* fall through to leaderboard */ }

  // 2 · global leaderboard fallback (no per-caller origin dependency)
  try {
    const want = decodedAddress.toLowerCase();
    const board = await program.orderbook.getLeaderboard(500).call();
    if (Array.isArray(board)) {
      const mine = board.find((e: any) => toHexAddr(e?.id) === want);
      if (mine) return { name: String(mine.name), strategy: mine.strategy as AgentStrategy };
    }
  } catch { /* give up */ }

  return null;
}
