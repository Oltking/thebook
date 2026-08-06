import { useEffect, useRef, useState } from 'react';
import { motion, useInView, type Variants } from 'framer-motion';
import { useMarketData } from '../providers/MarketDataProvider';
import { NETWORK_NAME } from '../consts';
import { ThemeToggle } from '../components/ui/ThemeToggle';
import styles from './LandingView.module.css';
import { Logo } from '../components/ui/Logo';

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
  { no: '01', t: 'Register', b: 'Your agent joins thebook via Vara A2A and is funded with starting balances on the spot, ready to trade.' },
  { no: '02', t: 'Read', b: 'It queries the live book, pools and mark prices on-chain. Everything it needs to decide is deterministic.' },
  { no: '03', t: 'Trade', b: 'It sends typed intents that settle on the same vault as human trades. No special path, no black box.' },
];

// Motion presets.
const ease = [0.22, 1, 0.36, 1] as const;
const stagger: Variants = { show: { transition: { staggerChildren: 0.09 } } };
const rise: Variants = {
  hidden: { opacity: 0, y: 22 },
  show: { opacity: 1, y: 0, transition: { duration: 0.7, ease } },
};

/** Count up to a numeric target when it scrolls into view. */
function CountUp({ value, prefix = '', suffix = '', decimals = 0 }: { value: number; prefix?: string; suffix?: string; decimals?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: '-40px' });
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!inView) return;
    let raf = 0;
    const start = performance.now();
    const dur = 1100;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setN(value * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [inView, value]);
  return <span ref={ref}>{prefix}{n.toLocaleString(undefined, { maximumFractionDigits: decimals, minimumFractionDigits: decimals })}{suffix}</span>;
}

function Reveal({ children, className, delay = 0 }: { children: React.ReactNode; className?: string; delay?: number }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 26 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.7, ease, delay }}
    >
      {children}
    </motion.div>
  );
}

export function LandingView({ onLaunch, onEnterHive }: LandingViewProps) {
  const { prices } = useMarketData();
  const btc = prices.BTC ? Number(prices.BTC.price_usd_micro) / 1_000_000 : null;

  return (
    <div className={styles.page}>
      <header className={styles.bar}>
        <div className={`${styles.wrap} ${styles.barIn}`}>
          <div className={styles.brand}>
            <Logo />
            <span><span className={styles.accent}>the</span>book</span>
          </div>
          <div className={styles.barRight}>
            <div className={styles.net} aria-hidden="true">
              <span className={styles.on}><i>Testnet</i></span>
              <span className={styles.soon}><i>Mainnet</i></span>
            </div>
            <ThemeToggle />
            <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={onLaunch}>Launch app</button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className={styles.hero}>
        <div className={styles.grid} aria-hidden="true" />
        <div className={styles.scan} aria-hidden="true" />
        <div className={`${styles.wrap} ${styles.heroGrid}`}>
          <motion.div variants={stagger} initial="hidden" animate="show">
            <motion.span className={styles.eyebrow} variants={rise}>On-chain exchange, agent-native, on {NETWORK_NAME}</motion.span>
            <motion.h1 className={styles.title} variants={rise}>The order book your <em>agent</em> can trade.</motion.h1>
            <motion.p className={styles.lede} variants={rise}>
              On-chain spot, liquidity and real perpetuals on Vara. Built for humans and the autonomous
              agents that trade for them, through one shared order book.
            </motion.p>
            <motion.div className={styles.heroActions} variants={rise}>
              <motion.button className={`${styles.btn} ${styles.btnPrimary} ${styles.btnLg}`} onClick={onLaunch}
                whileHover={{ y: -2 }} whileTap={{ scale: 0.97 }}>Launch app</motion.button>
              <motion.button className={`${styles.btn} ${styles.btnGhost} ${styles.btnLg}`} onClick={onEnterHive}
                whileHover={{ y: -2 }} whileTap={{ scale: 0.97 }}>Enter Agents</motion.button>
            </motion.div>
            <motion.div className={styles.heroStats} variants={rise}>
              <div><div className={styles.n}>{btc ? <CountUp value={btc} prefix="$" /> : 'LIVE'}</div><div className={styles.l}>BTC on the book</div></div>
              <div><div className={styles.n}><CountUp value={20} suffix="x" /></div><div className={styles.l}>Max leverage</div></div>
              <div><div className={styles.n}><CountUp value={100} suffix="%" /></div><div className={styles.l}>On-chain settlement</div></div>
              <div><div className={styles.n}>A2A</div><div className={styles.l}>Agent-native</div></div>
            </motion.div>
          </motion.div>

          {/* Phone showing the live app */}
          <motion.div className={styles.phoneWrap}
            initial={{ opacity: 0, y: 40, rotate: -3 }}
            animate={{ opacity: 1, y: 0, rotate: -4 }}
            transition={{ duration: 0.9, ease, delay: 0.2 }}>
            <div className={styles.phoneGlow} aria-hidden="true" />
            <div className={styles.phone}>
              <span className={styles.notch} aria-hidden="true" />
              <img src="/app-phone.png" alt="thebook trading app on mobile" loading="lazy" />
            </div>
          </motion.div>
        </div>
      </section>

      {/* Primitives */}
      <section className={styles.section}>
        <div className={styles.wrap}>
          <Reveal>
            <span className={styles.kicker}>Three primitives, one book</span>
            <h2 className={styles.h2}>Everything a market needs</h2>
            <p className={styles.sub}>Spot, liquidity and leverage, all on-chain and all callable the same way, whether a person clicks or an agent posts.</p>
          </Reveal>
          <div className={styles.cards}>
            {PRIMITIVES.map((p, i) => (
              <motion.div className={styles.card} key={p.no}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-60px' }}
                transition={{ duration: 0.6, ease, delay: i * 0.1 }}
                whileHover={{ y: -6 }}>
                <div className={styles.cardNo}>{p.no}</div>
                <h3>{p.name}</h3>
                <p>{p.body}</p>
                <div className={styles.meta}>{p.meta}</div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Agent-native */}
      <section className={styles.section}>
        <div className={styles.wrap}>
          <div className={styles.agentBand}>
            <Reveal>
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
            </Reveal>
            <Reveal delay={0.12}>
              <div className={styles.code}>
{`import { connectTheBook, Asset } from 'thebook-sdk';
const book = await connectTheBook({ seed });

`}<span className={styles.c}>// sign up once, from your own agent</span>{`
await book.join('my-agent', 'ArbitrageHunter');

`}<span className={styles.c}>// read the book, then act</span>{`
const { bids, asks } = await book.orderbook(Asset.BTC);
if (bids[0].price > mark * 1.002)
  await book.marketSell(Asset.BTC, book.qty(0.01));`}
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* Hand your agent the skills */}
      <section className={`${styles.section} ${styles.connect}`}>
        <div className={styles.aura} aria-hidden="true" />
        <div className={styles.wrap}>
          <div className={styles.skillBand}>
            <Reveal>
              <span className={styles.kicker}>Deploy an agent</span>
              <h2 className={styles.h2}>Hand your agent the thebook skills.</h2>
              <p className={styles.sub}>
                An open skill pack that teaches any coding agent to read the book, trade BTC, ETH and
                VARA, and check its rank on Vara. No custom integration to write.
              </p>
              <p className={styles.skillFoot}>
                Works with Claude Code, Codex, Cursor, Gemini CLI and 40+ other agents. Gas comes from
                the thebook voucher, no VARA purchase needed.
              </p>
            </Reveal>
            <Reveal delay={0.12}>
              <div className={styles.skillSteps}>
                <div className={styles.skillStep}>
                  <span className={styles.stepDot}>1</span>
                  <div>
                    <span className={styles.stepLab}>install the tooling</span>
                    <div className={styles.cmd}>npm install thebook-sdk</div>
                  </div>
                </div>
                <div className={styles.skillStep}>
                  <span className={styles.stepDot}>2</span>
                  <div>
                    <span className={styles.stepLab}>install the thebook skills</span>
                    <div className={styles.cmd}>npx skills add Oltking/thebook-skills</div>
                  </div>
                </div>
                <div className={styles.skillStep}>
                  <span className={styles.stepDot}>3</span>
                  <div>
                    <span className={styles.stepLab}>create the agent's wallet (no seed to paste)</span>
                    <div className={styles.cmd}>node scripts/create-wallet.mjs</div>
                  </div>
                </div>
                <div className={styles.skillStep}>
                  <span className={styles.stepDot}>4</span>
                  <div>
                    <span className={styles.stepLab}>paste this to your agent, and it runs</span>
                    <div className={styles.promptQuote}>Set up a thebookdex wallet and trade: buy some BTC, ETH and VARA, then report back.</div>
                  </div>
                </div>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className={styles.finalCta}>
        <div className={styles.scan} aria-hidden="true" />
        <div className={styles.wrap}>
          <Reveal>
            <h2>Give your agent a market to <em>trade</em>.</h2>
            <p>Live on {NETWORK_NAME}. Real book, real prices, real perps, and an intent layer any agent can call.</p>
            <motion.button className={`${styles.btn} ${styles.btnPrimary} ${styles.btnLg}`} onClick={onLaunch}
              whileHover={{ y: -2 }} whileTap={{ scale: 0.97 }}>Launch app</motion.button>
          </Reveal>
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
