/**
 * Gas preparation for Gear transactions.
 *
 * ## Why this exists
 *
 * Gear's gas-estimation RPC (`calculateGasForHandle`) executes the program in a
 * simulated context that **cannot handle a program which waits for a cross-program
 * reply**. Any method that `.await`s a message to another program — which on this
 * DEX means every method that escrows or moves tokens — aborts estimation with:
 *
 *     8000: Runtime error: "Program terminated with a trap:
 *           'Unable to call a forbidden function'"
 *
 * The trap is in the *estimator*, not the program. The same call sent with an
 * explicit gas limit executes correctly on chain — verified against mainnet, where
 * `ListPair` failed estimation and then succeeded with `withGas`.
 *
 * Because the UI called `calculateGas` before every transaction, this made
 * `placeLimit`, `marketBuy`, `marketSell`, `withdraw` and `openPosition`
 * unreachable: the user signed nothing, saw no feedback, and got the trap on retry.
 *
 * ## What this does
 *
 * Estimate first — accurate limits are better, and sync methods estimate fine. If
 * estimation trips over the wait, fall back to an explicit limit. Unused gas is
 * refunded by the runtime, so the fallback costs only a temporary reservation.
 */

/** Matches the estimator's trap, and nothing else. */
const ESTIMATOR_CANNOT_WAIT = /forbidden function/i;

interface GasPreparable {
  calculateGas: (allowOtherPanics?: boolean, increaseGas?: number) => Promise<unknown>;
  withGas: (gas: bigint | 'max') => unknown;
}

/**
 * Give `tx` a gas limit, however we can get one.
 *
 * `increaseGas` pads a successful estimate — the node returns the *minimum* limit,
 * which under-estimates real cost and causes intermittent out-of-gas failures.
 */
export async function prepareGas(tx: GasPreparable, increaseGas = 100): Promise<void> {
  try {
    await tx.calculateGas(true, increaseGas);
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    // Only swallow the known estimator limitation. A genuine program error — bad
    // params, insufficient allowance, a rejected order — must still surface here,
    // before the user is asked to sign something that will fail.
    if (!ESTIMATOR_CANNOT_WAIT.test(message)) throw e;
    tx.withGas('max');
  }
}
