export function parseContractError(e: unknown): string {
  if (e == null) return 'Unknown error';
  const msg = String(e);
  if (msg.includes('InsufficientUsd')) return 'You don\'t have enough USD balance. Deposit USD to continue.';
  if (msg.includes('InsufficientAsset')) return 'You don\'t have enough balance of that asset.';
  if (msg.includes('JoinFirst')) return 'You need to join the DEX first. Click "Join DEX" in the header — it\'s a one-time setup.';
  if (msg.includes('NotAuthorized')) return 'You are not authorized to perform this action.';
  if (msg.includes('OrderNotFound')) return 'This order no longer exists. It may have been filled or cancelled.';
  if (msg.includes('OrderAlreadyDone')) return 'This order has already been filled or cancelled.';
  if (msg.includes('NoLiquidity')) return 'There is not enough liquidity to execute this trade. Try a smaller amount.';
  if (msg.includes('NoBuyers')) return 'No buyers available at this price. Try lowering your price.';
  if (msg.includes('PoolExists')) return 'This liquidity pool already exists.';
  if (msg.includes('PoolNotFound')) return 'Pool not found. It may have been removed.';
  if (msg.includes('SameAssetPool')) return 'You cannot create a pool with the same asset on both sides.';
  if (msg.includes('InsufficientLiquidity')) return 'Insufficient liquidity in the pool for this swap. Try a smaller amount.';
  if (msg.includes('SlippageExceeded')) return 'Price moved more than your slippage tolerance. Try increasing slippage or try again.';
  if (msg.includes('ZeroAmount')) return 'Amount must be greater than zero.';
  if (msg.includes('AgentCallFailed')) return 'Oracle service is unavailable. Please try again later.';
  if (msg.includes('BadParams')) return 'Invalid parameters provided. Check your inputs and try again.';
  if (msg.includes('InsufficientOracleCredit')) return 'Oracle budget has been depleted. Please try again later.';
  if (msg.includes('pool') || msg.includes('Pool')) return 'Pool operation failed. Please try again.';
  if (msg.includes('out of gas') || msg.includes('OutOfGas') || msg.includes('ran out of gas')) return 'The transaction ran out of gas. Please try again.';
  if (msg.includes('signAndSend') || msg.includes('signer')) return 'Transaction was rejected by your wallet or the network is congested. Try again.';
  if (msg.includes('timeout') || msg.includes('Timeout')) return 'The request timed out. The network may be congested. Please try again.';
  if (msg.includes('Connection') || msg.includes('connection')) return 'Connection lost. Please check your internet and try again.';
  return msg.length > 100 ? 'Transaction failed. Please try again.' : msg;
}
