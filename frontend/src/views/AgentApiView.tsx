import { useState } from 'react';
import { Check, Copy, Radio } from 'lucide-react';
import { PROGRAM_ID, NETWORK_NAME } from '../consts';
import styles from './AgentApiView.module.css';

/**
 * "For Agents" — the A2A surface. thebook is a Gear program on Vara; any other
 * program (an agent) reaches it the same way agents talk on Vara A2A: by sending
 * a typed message to its actor_id. This page documents the real callable
 * interface and shows the register → read → execute flow end to end.
 */

interface MethodRow {
  sig: string;
  desc: string;
}
interface Svc {
  name: string;
  tag: string;
  methods: MethodRow[];
}

const SERVICES: Svc[] = [
  {
    name: 'Orderbook',
    tag: 'orderbook',
    methods: [
      { sig: 'Join(name, strategy)', desc: 'Register the calling agent and fund its starting balances. Idempotent — re-joining returns the existing identity.' },
      { sig: 'MarketBuy(asset, qty)', desc: 'Take liquidity from the book immediately at the best available price.' },
      { sig: 'MarketSell(asset, qty)', desc: 'Sell into the book at the best bid.' },
      { sig: 'PlaceLimit(side, asset, price, qty)', desc: 'Rest an order on the book at a chosen price; returns the order id.' },
      { sig: 'CancelOrder(oid)', desc: 'Cancel one of the agent’s resting orders.' },
      { sig: 'CallAgentService(target, payload, gas)', desc: 'The A2A primitive — forward a typed call to another agent program by actor_id.' },
      { sig: 'query GetPortfolio()', desc: 'Read the agent’s USD / BTC / ETH / VARA balances.' },
      { sig: 'query GetOrderbook(asset)', desc: 'Read live bids and asks for a market.' },
    ],
  },
  {
    name: 'Amm',
    tag: 'amm',
    methods: [
      { sig: 'Swap(pool, assetIn, amountIn, minOut)', desc: 'Spot swap through a pool with slippage protection.' },
      { sig: 'AddLiquidity(pool, amountA, amountB)', desc: 'Provide liquidity; returns LP tokens minted.' },
      { sig: 'RemoveLiquidity(pool, lpAmount)', desc: 'Redeem LP tokens for the underlying pair.' },
      { sig: 'query ListPools()', desc: 'Enumerate every pool with reserves and price.' },
    ],
  },
  {
    name: 'Perps',
    tag: 'perps',
    methods: [
      { sig: 'OpenPosition(asset, isLong, margin, leverage)', desc: 'Open an isolated-margin perpetual; settled on-chain at the keeper mark.' },
      { sig: 'ClosePosition(asset)', desc: 'Close the agent’s position and realize PnL against the house reserve.' },
      { sig: 'query GetPositions(addr)', desc: 'Read open positions, entry, and liquidation price.' },
      { sig: 'query GetMarkPrice(asset)', desc: 'Read the current keeper mark price (USD cents).' },
    ],
  },
];

const STEPS = [
  { n: '01', t: 'Register the agent', b: 'Deploy your agent program on Vara and call Join(name, strategy) once. It gets an identity and balances on thebook.' },
  { n: '02', t: 'Read the market', b: 'Query GetOrderbook, ListPools or GetMarkPrice to size a trade. Everything an agent needs to decide is on-chain and deterministic.' },
  { n: '03', t: 'Execute & settle', b: 'Send the typed intent (MarketBuy, Swap, OpenPosition…). It settles on the same vault as human trades — no privileged path.' },
];

const SAMPLE = `import { Sails } from 'sails-js';

// thebook is just an actor on Vara — reach it by program id.
const book = await Sails.connect({
  endpoint: '${'wss://testnet.vara.network'}',
  programId: '${'0xTHEBOOK…'}',
});

// 1 · register this agent (idempotent)
await book.orderbook.join('my-agent', 'ArbitrageHunter');

// 2 · read the market
const { bids, asks } = await book.orderbook.getOrderbook('BTC');
const mark = await book.perps.getMarkPrice('ETH');

// 3 · act on it — same typed intent the UI uses
if (bids[0].price > mark * 1.002) {
  await book.orderbook.marketSell('BTC', qty);
}

// A2A: forward a call to another agent by actor_id
await book.orderbook.callAgentService(peerId, payload, gasLimit);`;

function highlight(src: string) {
  // lightweight token coloring for the sample
  return src.split('\n').map((line, i) => {
    const isComment = line.trimStart().startsWith('//');
    return (
      <div key={i} className={isComment ? styles.c : undefined}>
        {line || ' '}
      </div>
    );
  });
}

export function AgentApiView() {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(SAMPLE).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };
  const short = PROGRAM_ID && PROGRAM_ID.length > 14 ? `${PROGRAM_ID.slice(0, 8)}…${PROGRAM_ID.slice(-6)}` : PROGRAM_ID;

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        {/* Hero */}
        <div>
          <span className={styles.eyebrow}><span className={styles.dot} /> Agent-native · Vara A2A</span>
          <h1 className={styles.title}>Trade thebook from <span className={styles.g}>any agent</span>.</h1>
          <p className={styles.lede}>
            thebook is a program on {NETWORK_NAME}. Another agent reaches it exactly how agents talk on
            Vara A2A — a typed message to its actor id. Same intents the app uses, same on-chain
            settlement, no special SDK and no privileged path.
          </p>
        </div>

        {/* Flow */}
        <div className={styles.steps}>
          {STEPS.map((s) => (
            <div key={s.n} className={styles.step}>
              <div className={styles.stepNum}>{s.n}</div>
              <div className={styles.stepTitle}>{s.t}</div>
              <div className={styles.stepBody}>{s.b}</div>
            </div>
          ))}
        </div>

        {/* Code */}
        <div className={styles.section}>
          <div className={styles.sectionHead}>Call it in a few lines</div>
          <div className={styles.code}>
            <button className={styles.copyBtn} onClick={copy}>
              {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
            </button>
            {highlight(SAMPLE)}
          </div>
        </div>

        {/* Interface reference */}
        <div className={styles.section}>
          <div className={styles.sectionHead}>Callable interface</div>
          <div className={styles.sectionSub}>
            Every method below is a typed intent an agent can send. Queries are free reads; the rest are
            signed transactions that settle on-chain.
          </div>
          {SERVICES.map((svc) => (
            <div key={svc.name} className={styles.svc}>
              <div className={styles.svcHead}>
                {svc.name} <span className={styles.svcTag}>program.{svc.tag}</span>
              </div>
              {svc.methods.map((m) => (
                <div key={m.sig} className={styles.row}>
                  <div className={styles.sig}>{m.sig}</div>
                  <div className={styles.desc}>{m.desc}</div>
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* A2A callout */}
        <div className={styles.callout}>
          <div className={styles.calloutIcon}><Radio size={20} /></div>
          <div>
            <div className={styles.calloutTitle}>The A2A primitive: CallAgentService</div>
            <div className={styles.calloutBody}>
              Agents don’t just call thebook — they call each other through it. <code>CallAgentService(target, payload, gas)</code> forwards
              a typed message to another agent program by <code>actor_id</code>, so strategies can compose, delegate, or negotiate
              on-chain. thebook’s program id on {NETWORK_NAME} is <code>{short}</code>.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
