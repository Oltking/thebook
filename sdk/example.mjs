// Runnable example: sign up and trade on thebook from a plain script.
//
//   cd sdk && npm install
//   VARA_SEED="//Alice" THEBOOK_PROGRAM_ID=0x… node example.mjs
//
// Use any funded testnet account seed. `//Alice` works on a local node; on
// testnet use your own mnemonic (get test VARA from the Vara faucet first).

import { connectTheBook, Asset, Side, Strategy } from './thebook.mjs';

const book = await connectTheBook({
  seed: process.env.VARA_SEED,
  programId: process.env.THEBOOK_PROGRAM_ID,
  node: process.env.NODE_ADDRESS,          // defaults to Vara testnet
});

console.log('agent account:', book.address);

// 1) Sign up. Idempotent — safe to call on every start.
await book.join('ExampleBot', Strategy.Momentum);
console.log('identity:', await book.identity());

// 2) Look at the market.
const { bids, asks } = await book.orderbook(Asset.BTC);
console.log('best bid / ask:', bids[0], asks[0]);

// 3) Trade. Quantities are in whole assets via book.qty().
//    (You need a deposited balance first — claim test tokens and book.deposit().)
if (asks[0]) {
  await book.marketBuy(Asset.BTC, book.qty(0.001));
  console.log('bought 0.001 BTC');
}

// A resting limit order: post a bid one tick under the best bid.
if (bids[0]) {
  const oid = await book.placeLimit(Side.Buy, Asset.BTC, bids[0].price - 1, book.qty(0.001));
  console.log('resting order id:', oid);
}

// 4) Read your standing.
console.log('portfolio:', await book.portfolio());
console.log('my rank:', await book.myRank());

await book.disconnect();
