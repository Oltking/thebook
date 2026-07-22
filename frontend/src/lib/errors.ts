export function parseContractError(e: unknown): string {
  if (e == null) return 'Unknown error';
  // A decoded ContractError arrives as an object like { insufficientUsd: null }
  // or a string. String(object) is "[object Object]", so normalize first: use
  // the Error message, the first object key, or a JSON dump.
  let msg: string;
  if (typeof e === 'string') msg = e;
  else if (e instanceof Error) msg = e.message;
  else if (typeof e === 'object') {
    const keys = Object.keys(e as object);
    msg = keys.length ? keys.join(' ') : JSON.stringify(e);
  } else msg = String(e);
  const lower = msg.toLowerCase();
  const has = (s: string) => lower.includes(s.toLowerCase());

  if (has('InsufficientUsd')) return 'You don\'t have enough USD balance. Deposit USD to continue.';
  if (has('InsufficientAsset')) return 'You don\'t have enough balance of that asset.';
  if (has('JoinFirst')) return 'You need to create your agent first - click "Create Agent" to do the one-time setup.';
  if (has('NotAuthorized')) return 'You are not authorized to perform this action.';
  if (has('NotAdmin')) return 'This action is restricted to the DEX admin.';
  if (has('OrderNotFound')) return 'This order no longer exists. It may have been filled or cancelled.';
  if (has('OrderAlreadyDone')) return 'This order has already been filled or cancelled.';
  if (has('NoLiquidity')) return 'There is not enough liquidity to execute this trade. Try a smaller amount.';
  if (has('NoBuyers')) return 'No buyers available at this price. Try lowering your price.';
  if (has('PoolExists')) return 'This liquidity pool already exists.';
  if (has('PoolNotFound')) return 'Pool not found. It may have been removed.';
  if (has('SameAssetPool')) return 'You cannot create a pool with the same asset on both sides.';
  if (has('InsufficientLiquidity')) return 'Insufficient liquidity in the pool for this swap. Try a smaller amount.';
  if (has('SlippageExceeded')) return 'Price moved more than your slippage tolerance. Try increasing slippage or try again.';
  if (has('ZeroAmount')) return 'Amount must be greater than zero.';
  if (has('BookFull')) return 'The order book is full right now. Try a market order or place your limit order again shortly.';
  if (has('NoMarkPrice')) return 'No mark price is published for this market yet. The price keeper may be catching up - try again shortly.';
  if (has('LeverageTooHigh')) return 'That leverage is above the maximum allowed. Lower your leverage and try again.';
  if (has('PositionNotFound')) return 'You have no open position in this market.';
  if (has('WrongDirection')) return 'You already have a position the other way. Close it before opening the opposite side.';
  if (has('NotLiquidatable')) return 'This position is still above maintenance margin and cannot be liquidated.';
  if (has('StaleMark')) return 'The mark price is stale - the price keeper is catching up. Try again in a moment.';
  if (has('AgentCallFailed')) return 'The token transfer failed. Make sure you approved the DEX and have enough balance, then try again.';
  if (has('BadParams')) return 'Invalid parameters provided. Check your inputs and try again.';
  if (has('pool') || msg.includes('Pool')) return 'Pool operation failed. Please try again.';
  if (has('out of gas') || msg.includes('OutOfGas') || msg.includes('ran out of gas')) return 'The transaction ran out of gas. Please try again.';
  if (has('signAndSend') || msg.includes('signer')) return 'Transaction was rejected by your wallet or the network is congested. Try again.';
  if (has('timeout') || msg.includes('Timeout')) return 'The request timed out. The network may be congested. Please try again.';
  if (has('Connection') || msg.includes('connection')) return 'Connection lost. Please check your internet and try again.';
  return msg.length > 100 ? 'Transaction failed. Please try again.' : msg;
}
