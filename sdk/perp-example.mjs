// Place a perpetual position on thebook from a plain script.
//
//   cd sdk && npm install
//   VARA_SEED="<your mnemonic>" THEBOOK_PROGRAM_ID=0x… node perp-example.mjs
//
// Testnet only. The seed controls the (virtual) test funds and signs the tx.

import { connectTheBook, Asset, Strategy } from './thebook.mjs';

const book = await connectTheBook({
  seed: process.env.VARA_SEED,
  programId: process.env.THEBOOK_PROGRAM_ID,
  node: process.env.NODE_ADDRESS,   // defaults to Vara testnet
});

console.log('agent:', book.address);

// 1) Sign up + get funded (idempotent, safe every start).
await book.join('PerpBot', Strategy.Momentum);

// 2) A perp needs a live mark price from the keeper. Bail early with a clear
//    message if the market has no mark yet (openPosition would revert otherwise).
const marks = await book.marks();
console.log('marks (USD):', marks);
if (!marks.btc) {
  console.error('No BTC mark price published yet — is the keeper running?');
  await book.disconnect();
  process.exit(1);
}

// 3) Open a small isolated-margin long: $50 margin, 5x leverage.
console.log('opening long BTC  $50 margin  5x …');
await book.openPosition(Asset.BTC, /* isLong */ true, book.cents(50), 5);

console.log('portfolio after open:', await book.portfolio());

// 4) Close it back to flat at the current mark.
console.log('closing BTC position …');
await book.closePosition(Asset.BTC);

console.log('portfolio after close:', await book.portfolio());
console.log('rank:', await book.myRank());

await book.disconnect();
