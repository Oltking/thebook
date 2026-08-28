import type { Signer } from '@polkadot/types/types';

/**
 * Narrow the wallet extension's `Signer` to the one our API stack expects.
 *
 * `@polkadot/extension-dapp` and `@gear-js/react-hooks` each pull their own
 * `@polkadot/types`, so depending on how npm hoists the tree there can be two
 * structurally identical `Signer` interfaces that TypeScript treats as unrelated.
 * The object is the same object at runtime — the wallet's injected signer — and
 * only the declaration it is attributed to differs.
 *
 * This is the one place that mismatch is asserted away, so it stays visible and
 * cannot spread. If the duplicate ever disappears from the dependency tree, this
 * becomes a harmless no-op rather than something to hunt down.
 */
export function asSigner(signer: unknown): Signer {
  return signer as Signer;
}
