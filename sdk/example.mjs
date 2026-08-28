// Runnable example: trade the non-custodial spot CLOB on thebookdex from a plain
// script. This is the real mainnet flow — approve, place, read, withdraw.
//
//   cd sdk && npm install
//   VARA_SEED="your twelve word mnemonic" \
//   THEBOOK_PROGRAM_ID=0xe7540b7c404234b4345720a43138f58ba4af7de9367ff8fd2b4428586daf66a3 \
//   node example.mjs
//
// The seed is a funded Vara MAINNET account holding the bridged tokens you want to
// trade (wUSDT/wUSDC to buy, wETH/wVARA to sell). Node defaults to Vara mainnet.

import { connectTheBook, Side } from './thebook.mjs';

const book = await connectTheBook({
  seed: process.env.VARA_SEED,
  programId: process.env.THEBOOK_PROGRAM_ID,
  node: process.env.NODE_ADDRESS,          // defaults to Vara mainnet (wss://rpc.vara.network)
});

console.log('agent account:', book.address);

// 1) Discover the curated markets (read live from Spot/GetPairs).
const pairs = await book.spot.pairs();
console.log('markets:', pairs.map((p) => `#${p.id} base=${p.base} quote=${p.quote}`));

// Trade the first active market. Each pair carries its base/quote token ids and
// their decimals (wETH 18, wVARA 12, wUSDT/wUSDC 6).
const pair = pairs.find((p) => p.active);
if (!pair) { console.log('no active markets'); await book.disconnect(); process.exit(0); }
const baseDec = Number(pair.base_dec);
const quoteDec = Number(pair.quote_dec);

// 2) Look at the book.
const { bids, asks } = await book.spot.orderbook(pair.id);
console.log('best bid / ask:', bids[0], asks[0]);

// 3) Place a resting bid: buy 0.01 base @ $2500 (quote units per whole base).
//    A BUY escrows QUOTE, so approve the quote token first — for exactly what this
//    order escrows, not a standing allowance.
const price = book.units(2500, quoteDec);   // 2500 quote-units per whole base
const qty   = book.units(0.01, baseDec);    // 0.01 base
const escrow = (price * qty) / 10n ** BigInt(baseDec);   // quote this order escrows
await book.spot.approve(pair.quote, escrow);
const oid = await book.spot.placeLimit(pair.id, Side.Buy, price, qty);
console.log('resting order id:', oid);

// 4) Read your standing.
console.log('my orders:', await book.spot.myOrders());
console.log('claimable base:', await book.spot.claim(pair.base));

// 5) Withdraw any filled proceeds / cancelled escrow back to your wallet.
await book.spot.withdraw(pair.base);
await book.spot.withdraw(pair.quote);

await book.disconnect();
