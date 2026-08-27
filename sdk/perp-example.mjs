// Open a cash-settled perpetual position on thebookdex from a plain script.
//
//   cd sdk && npm install
//   VARA_SEED="<your mnemonic>" \
//   THEBOOK_PROGRAM_ID=0x7c5dbc8a85a8526c3a0c4fe98f0fb286782849c4d130ff28d6b7b30d157c2484 \
//   node perp-example.mjs
//
// NOTE: perps are built and deployed but NOT yet enabled on mainnet (no live mark
// keeper), so this example bails early until a market has a fresh mark. The flow is
// the real PerpsV1 one: collateral is wUSDT (6 decimals), margin is escrowed via a
// prior spot.approve on the collateral token, and payouts settle to spot claims.

import { connectTheBook } from './thebook.mjs';

// wUSDT collateral on Vara mainnet (6 decimals).
const COLLATERAL = '0x4255ff4a87a4c13dc39f74ace8c4948bbef2f75fb639d66639a1cfcc99e6243e';
const COLLATERAL_DEC = 6;

const book = await connectTheBook({
  seed: process.env.VARA_SEED,
  programId: process.env.THEBOOK_PROGRAM_ID,
  node: process.env.NODE_ADDRESS,   // defaults to Vara mainnet
});

console.log('agent:', book.address);

// 1) Find an enabled, named market with a live mark. openPosition reverts if the
//    market has no fresh mark (keeper not running), so bail with a clear message.
const markets = await book.perps.markets();
const live = markets.find((m) => m.active && m.symbol && BigInt(m.mark) > 0n);
if (!live) {
  console.error('No perp market has a live mark yet — perps are not enabled on mainnet.');
  await book.disconnect();
  process.exit(1);
}
console.log('market:', live.symbol, 'mark:', String(live.mark));

// 2) Margin escrow needs an allowance on the collateral token (once, large amount).
await book.spot.approve(COLLATERAL, book.units(1_000_000, COLLATERAL_DEC));

// 3) Open a small isolated-margin long: 50 wUSDT margin, 5x leverage.
console.log(`opening long ${live.symbol}  50 wUSDT margin  5x …`);
await book.perps.open(live.id, /* isLong */ true, book.units(50, COLLATERAL_DEC), 5);

const positions = await book.perps.positions();
console.log('open positions:', positions);

// 4) Close it back to flat (pass the position id). Proceeds settle to a spot claim;
//    pull them out with book.spot.withdraw(COLLATERAL).
if (positions[0]) {
  console.log('closing position', String(positions[0].id), '…');
  await book.perps.close(positions[0].id);
  await book.spot.withdraw(COLLATERAL);
}

await book.disconnect();
