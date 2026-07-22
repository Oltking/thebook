import { useMarketData } from '../providers/MarketDataProvider';
import { NETWORK_NAME } from '../consts';
import styles from './LandingView.module.css';

interface LandingViewProps {
  onLaunch: () => void;
  onEnterHive: () => void;
}

const PRIMITIVES = [
  { no: '01', name: 'Spot', body: 'Trade BTC, ETH and VARA on a real on-chain order book. Market and limit orders, settled on Vara.', meta: <>maker / taker <b>book</b></> },
  { no: '02', name: 'Pools', body: 'Provide liquidity to AMM pools or quote both sides of the book. Earn the spread and the fees.', meta: <>up to <b>0.3%</b> fee</> },
  { no: '03', name: 'Perps', body: 'Real on-chain perpetual futures. Isolated margin, keeper mark price, permissionless liquidations.', meta: <>up to <b>20x</b> leverage</> },
];

const AGENT_STEPS = [
  { no: '01', t: 'Register', b: 'Your agent is its own on-chain program. On init it joins thebook via Vara A2A and gets an identity.' },
  { no: '02', t: 'Read', b: 'It queries the live book, pools and mark prices on-chain. Everything it needs to decide is deterministic.' },
  { no: '03', t: 'Trade', b: 'It sends typed intents that settle on the same vault as human trades. No special path, no black box.' },
];

export function LandingView({ onLaunch, onEnterHive }: LandingViewProps) {
  const { prices } = useMarketData();
  const btc = prices.BTC ? Number(prices.BTC.price_usd_micro) / 1_000_000 : null;

  return (
    <div className={styles.page}>
      <header className={styles.bar}>
        <div className={`${styles.wrap} ${styles.barIn}`}>
          <div className={styles.brand}>
            <img src="/logo.png" alt="" aria-hidden="true" />
            <span><span className={styles.accent}>the</span>book</span>
          </div>
          <div className={styles.barRight}>
            <div className={styles.net} aria-hidden="true">
              <span className={styles.on}><i>Testnet</i></span>
              <span className={styles.soon}><i>Mainnet</i></span>
            </div>
            <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={onLaunch}>Launch app</button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className={styles.hero}>
        <div className={styles.wrap}>
          <span className={styles.eyebrow}>On-chain exchange, agent-native, on {NETWORK_NAME}</span>
          <h1 className={styles.title}>The order book your <em>agent</em> can trade.</h1>
          <p className={styles.lede}>
            On-chain spot, liquidity and real perpetuals on Vara. Built for humans and the autonomous
            agents that trade for them, through one shared order book.
          </p>
          <div className={styles.heroActions}>
            <button className={`${styles.btn} ${styles.btnPrimary} ${styles.btnLg}`} onClick={onLaunch}>Launch app</button>
            <button className={`${styles.btn} ${styles.btnGhost} ${styles.btnLg}`} onClick={onEnterHive}>Enter the hive</button>
          </div>
          <div className={styles.heroStats}>
            <div><div className={styles.n}>{btc ? `$${btc.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : 'LIVE'}</div><div className={styles.l}>BTC on the book</div></div>
            <div><div className={styles.n}>20x</div><div className={styles.l}>Max leverage</div></div>
            <div><div className={styles.n}>100%</div><div className={styles.l}>On-chain settlement</div></div>
            <div><div className={styles.n}>A2A</div><div className={styles.l}>Agent-native</div></div>
          </div>
        </div>
      </section>

      {/* Primitives */}
      <section className={styles.section}>
        <div className={styles.wrap}>
          <span className={styles.kicker}>Three primitives, one book</span>
          <h2 className={styles.h2}>Everything a market needs</h2>
          <p className={styles.sub}>Spot, liquidity and leverage, all on-chain and all callable the same way, whether a person clicks or an agent posts.</p>
          <div className={styles.cards}>
            {PRIMITIVES.map((p) => (
              <div className={styles.card} key={p.no}>
                <div className={styles.cardNo}>{p.no}</div>
                <h3>{p.name}</h3>
                <p>{p.body}</p>
                <div className={styles.meta}>{p.meta}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Agent-native */}
      <section className={styles.section}>
        <div className={styles.wrap}>
          <div className={styles.agentBand}>
            <div>
              <span className={styles.kicker}>Agent-native, Vara A2A</span>
              <h2 className={styles.h2}>Any agent can trade it</h2>
              <p className={styles.sub}>
                thebook is a program on Vara. Another agent reaches it exactly how agents talk on Vara A2A,
                a typed message to its address. Same intents the app uses, same settlement.
              </p>
              <div className={styles.steps}>
                {AGENT_STEPS.map((s) => (
                  <div className={styles.step} key={s.no}>
                    <div className={styles.no}>{s.no}</div>
                    <div><h4>{s.t}</h4><p>{s.b}</p></div>
                  </div>
                ))}
              </div>
            </div>
            <div className={styles.code}>
{`// any agent, over Vara A2A
const book = connect('thebook.vara');

`}<span className={styles.c}>// register once</span>{`
await book.orderbook.join('my-agent', 'ArbitrageHunter');

`}<span className={styles.c}>// read the book, then act</span>{`
const { bids, asks } = await book.getOrderbook('BTC');
if (bids[0].price > mark * 1.002)
  await book.marketSell('BTC', qty);`}
            </div>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className={styles.finalCta}>
        <div className={styles.wrap}>
          <h2>Give your agent a market to <em>trade</em>.</h2>
          <p>Live on {NETWORK_NAME}. Real book, real prices, real perps, and an intent layer any agent can call.</p>
          <button className={`${styles.btn} ${styles.btnPrimary} ${styles.btnLg}`} onClick={onLaunch}>Launch app</button>
        </div>
      </section>

      <footer className={styles.wrap}>
        <div className={styles.foot}>
          <span>thebook, built on Vara</span>
          <span>On-chain spot, pools and perps</span>
        </div>
      </footer>
    </div>
  );
}
