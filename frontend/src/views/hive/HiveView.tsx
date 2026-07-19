import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSails } from '../../hooks/useSails';
import { usePortfolio } from '../../hooks/usePortfolio';
import { useMarketData } from '../../providers/MarketDataProvider';
import { findOpportunities, type Opportunity, type StrategyName } from '../../lib/opportunities';
import { fetchAgentBrief } from '../../lib/agentBrief';
import { resolveIdentity } from '../../lib/identity';
import { AgentConstellation, type HiveNode } from './AgentConstellation';
import { Header } from '../../components/layout/Header';
import styles from './HiveView.module.css';

interface HiveViewProps {
  onExitHive: () => void;
  onDeploy: () => void;
}

const STRAT: Record<StrategyName, { color: string; desc: string; glyph: string }> = {
  ArbitrageHunter: { color: '#1DB954', desc: 'Hunts price gaps across the book, pools, and spot.', glyph: '⟠' },
  MarketMaker: { color: '#C9D2CA', desc: 'Quotes both sides of the book and earns the spread.', glyph: '◈' },
  Momentum: { color: '#9A784B', desc: 'Rides assets that are trending and moving fast.', glyph: '▲' },
};

const SUGGESTIONS = ['Who is leading the hive?', 'What should I trade now?', 'Find me an edge', 'Explain my agent'];

// The looping word in the headline: type it, hold, delete, move to the next.
const HEADLINE_WORDS = ['awake', 'active', 'trading', 'earning'];

function hexOf(id: unknown): string {
  if (typeof id === 'string') return id.toLowerCase();
  if (Array.isArray(id)) return '0x' + id.map((b) => Number(b).toString(16).padStart(2, '0')).join('');
  return String(id).toLowerCase();
}

interface Leader { addr: string; name: string; strategy: StrategyName; netWorth: number; }

export function HiveView({ onExitHive, onDeploy }: HiveViewProps) {
  const { program, account } = useSails();
  const { portfolio } = usePortfolio();
  const { prices, orderbooks, pools, trades } = useMarketData();

  const [leaders, setLeaders] = useState<Leader[]>([]);
  const [identity, setIdentity] = useState<{ name: string; strategy: StrategyName } | null>(null);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const [reply, setReply] = useState<string | null>(null);
  const [typed, setTyped] = useState('awake');

  // Typewriter loop for the headline word.
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let wordIdx = 0;
    let charIdx = HEADLINE_WORDS[0].length;
    let deleting = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const word = HEADLINE_WORDS[wordIdx];
      if (!deleting) {
        charIdx += 1;
        setTyped(word.slice(0, charIdx));
        if (charIdx >= word.length) { deleting = true; timer = setTimeout(tick, 1500); return; }
        timer = setTimeout(tick, 95);
      } else {
        charIdx -= 1;
        setTyped(word.slice(0, Math.max(0, charIdx)));
        if (charIdx <= 0) { deleting = false; wordIdx = (wordIdx + 1) % HEADLINE_WORDS.length; timer = setTimeout(tick, 350); return; }
        timer = setTimeout(tick, 48);
      }
    };
    timer = setTimeout(tick, 1500);
    return () => clearTimeout(timer);
  }, []);

  const myAddr = account?.decodedAddress?.toLowerCase() ?? '';

  useEffect(() => {
    let on = true;
    const fetchBoard = async () => {
      if (!program) return;
      try {
        const board = await program.orderbook.getLeaderboard(50).call();
        if (on && Array.isArray(board)) {
          setLeaders(board.map((e: any) => ({
            addr: hexOf(e.id),
            name: String(e.name),
            strategy: (e.strategy as StrategyName) ?? 'ArbitrageHunter',
            netWorth: Number(e.net_worth ?? e.usd ?? 0) / 100,
          })));
        }
      } catch { /* leaderboard unavailable */ }
    };
    fetchBoard();
    // Poll so a freshly deployed agent shows up without a manual refresh.
    const iv = setInterval(() => { if (!document.hidden) fetchBoard(); }, 8000);
    return () => { on = false; clearInterval(iv); };
  }, [program, portfolio]);

  useEffect(() => {
    let on = true;
    (async () => {
      if (!program || !account) { setIdentity(null); return; }
      const r = await resolveIdentity(program, account.decodedAddress);
      if (on) setIdentity(r as { name: string; strategy: StrategyName } | null);
    })();
    return () => { on = false; };
  }, [program, account, portfolio]);

  const spot = (a: 'BTC' | 'ETH' | 'VARA') => {
    const f = prices[a];
    return f ? Number(f.price_usd_micro) / 1_000_000 : 0;
  };
  const myNetWorth = useMemo(() => {
    if (!portfolio) return 0;
    return Number(portfolio.usd) / 100
      + (Number(portfolio.btc) / 1e5) * spot('BTC')
      + (Number(portfolio.eth) / 1e5) * spot('ETH')
      + (Number(portfolio.vara) / 1e5) * spot('VARA');
  }, [portfolio, prices]);

  const opportunities = useMemo<Opportunity[]>(() => {
    const obs: Record<string, { bids: [bigint, bigint][]; asks: [bigint, bigint][] }> = {};
    for (const a of ['BTC', 'ETH', 'VARA']) obs[a] = (orderbooks[a] as any) || { bids: [], asks: [] };
    return findOpportunities({ prices, orderbooks: obs, pools } as any, identity?.strategy);
  }, [prices, orderbooks, pools, identity]);

  // Build the roster: the leaderboard agents, with the connected user surfaced
  // first (and given a live thought) if they've joined.
  const roster = useMemo(() => {
    const rows = leaders.map((l) => ({ ...l, me: l.addr === myAddr }));
    // Surface the connected user's agent as soon as they've joined, even if the
    // per-caller identity read is lagging (a portfolio means they registered).
    const joined = !!identity || !!portfolio;
    if (joined && myAddr && !rows.some((r) => r.me)) {
      rows.unshift({
        addr: myAddr,
        name: identity?.name || 'Your agent',
        strategy: identity?.strategy || 'ArbitrageHunter',
        netWorth: myNetWorth,
        me: true,
      });
    }
    rows.sort((a, b) => (a.me ? -1 : b.me ? 1 : b.netWorth - a.netWorth));
    return rows.slice(0, 6);
  }, [leaders, identity, portfolio, myAddr, myNetWorth]);

  const nodes: HiveNode[] = useMemo(() => {
    const max = Math.max(1, ...roster.map((r) => r.netWorth));
    return roster.map((r) => ({
      label: r.name.length > 10 ? r.name.slice(0, 10) : r.name,
      color: STRAT[r.strategy]?.color ?? '#1DB954',
      live: r.me ? true : r.netWorth > 0,
      weight: Math.min(1, 0.35 + (r.netWorth / max) * 0.65),
    }));
  }, [roster]);

  const activity = useMemo(() => {
    const fills: { t: string; text: string; kind: 'trade' }[] = [];
    for (const a of ['BTC', 'ETH', 'VARA'] as const) {
      for (const tr of (trades[a] || []).slice(0, 4)) {
        const px = Number(tr.price) * 1000;
        fills.push({
          t: tr.time || '',
          kind: 'trade',
          text: `Filled ${(Number(tr.qty) / 1e5).toFixed(4)} ${a} at $${px.toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
        });
      }
    }
    return fills.slice(0, 6);
  }, [trades]);

  const ask = useCallback(async (q: string) => {
    const text = q.trim();
    if (!text || thinking) return;
    setInput(''); setThinking(true); setReply(null);
    const market: Record<string, { price: number; change24h: number } | null> = {};
    for (const a of ['BTC', 'ETH', 'VARA'] as const) {
      const f = prices[a];
      market[a] = f ? { price: Number(f.price_usd_micro) / 1_000_000, change24h: Number(f.change_24h_bps) / 100 } : null;
    }
    const res = await fetchAgentBrief({
      name: identity?.name || 'the hive',
      strategy: identity?.strategy || 'ArbitrageHunter',
      opportunities, market,
    });
    setReply(res.text); setThinking(false);
  }, [thinking, prices, identity, opportunities]);

  const totalActions = useMemo(() => activity.length + opportunities.length, [activity, opportunities]);
  const fmtUsd = (v: number) => `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  const awake = roster.filter((r) => r.me || r.netWorth > 0).length;

  return (
    <div className={styles.world}>
      {/* Same header as the trading side (uniform), with the Hive active and a
          Deploy button added. */}
      <Header world="hive" onMenuClick={() => {}} onEnterHive={() => {}}
        onExitHive={onExitHive} onDeploy={onDeploy} />

      <section className={styles.hive}>
        <AgentConstellation nodes={nodes} />
        <div className={styles.wrap}>
          <span className={styles.eyebrow}>Agent ecosystem · live on Vara A2A</span>
          <h1 className={styles.title}>Your agents are <em>{typed}<span className={styles.caret} /></em></h1>
          <p className={styles.lede}>
            Not a dashboard, a hive. Spin up autonomous traders, watch them read the book and act,
            and direct the whole swarm from one line.
          </p>
          <div className={styles.statusline}>
            <span className={styles.syncdot} />swarm
            <span className={styles.sep}>/</span>{leaders.length} nodes
            <span className={styles.sep}>/</span>{opportunities.length} signals
            <span className={styles.sep}>/</span>vara-testnet
            <span className={styles.sep}>/</span><span style={{ color: 'var(--green)' }}>sync ok</span>
          </div>

          <div className={styles.console}>
            <form className={styles.consoleRow} onSubmit={(e) => { e.preventDefault(); ask(input); }}>
              <span className={styles.glyph} />
              <input value={input} onChange={(e) => setInput(e.target.value)}
                placeholder="Direct the hive.  e.g. what should I trade now?" aria-label="Command the hive" />
              <button type="submit" className={styles.send} disabled={thinking || !input.trim()} aria-label="Send">
                {thinking ? '…' : '➔'}
              </button>
            </form>
            <div className={styles.chips}>
              {SUGGESTIONS.map((s) => (
                <button key={s} className={styles.chip} onClick={() => ask(s)} disabled={thinking}>{s}</button>
              ))}
            </div>
          </div>

          {(thinking || reply) && (
            <div className={styles.reply}>
              <span className={styles.rg}>◇</span>
              <span>{thinking ? 'The hive is thinking…' : reply}</span>
            </div>
          )}

          <div className={styles.hstats}>
            <div className={styles.hstat}><div className={styles.n} style={{ color: 'var(--green)' }}>{awake}</div><div className={styles.l}>Agents awake</div></div>
            <div className={styles.hstat}><div className={styles.n} style={{ color: 'var(--brown)' }}>{leaders.length}</div><div className={styles.l}>On the book</div></div>
            <div className={styles.hstat}><div className={styles.n} style={{ color: 'var(--grey)' }}>{opportunities.length}</div><div className={styles.l}>Live signals</div></div>
            <div className={styles.hstat}><div className={styles.n}>{portfolio ? fmtUsd(myNetWorth) : '-'}</div><div className={styles.l}>Your net worth</div></div>
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.wrap}>
          <div className={styles.secHead}>
            <div><h2>The swarm</h2><p>Every agent is an on-chain identity with its own strategy and balance. Yours sits up front.</p></div>
          </div>
          <div className={styles.roster}>
            {roster.map((r) => {
              const meta = STRAT[r.strategy] ?? STRAT.ArbitrageHunter;
              const topThought = r.me ? (opportunities[0]?.rationale || 'Scanning the book, pools, and spot for an edge.') : meta.desc;
              return (
                <div key={r.addr} className={`${styles.agent} ${r.me ? styles.me : ''}`}>
                  <div className={styles.halo} style={{ background: meta.color }} />
                  <div className={styles.aTop}>
                    <div className={styles.orb} style={{ color: meta.color, background: `${meta.color}22` }}>{meta.glyph}</div>
                    <div>
                      <div className={styles.aName}>{r.name}{r.me ? ' · you' : ''}</div>
                      <div className={styles.aStrat}>{r.strategy.replace(/([A-Z])/g, ' $1').trim()}</div>
                    </div>
                    <span className={`${styles.status} ${r.me || r.netWorth > 0 ? styles.live : styles.idle}`}>
                      {r.me || r.netWorth > 0 ? '● Live' : '◐ Idle'}
                    </span>
                  </div>
                  <div className={styles.thought}>
                    <span className={styles.lab}>{r.me ? 'Thinking' : 'Strategy'}</span>{topThought}
                  </div>
                  <div className={styles.metrics}>
                    <div><span className={styles.v} style={{ color: 'var(--green)' }}>{fmtUsd(r.netWorth)}</span><span className={styles.k}>Net worth</span></div>
                    {r.me && <div><span className={styles.v}>{opportunities.length}</span><span className={styles.k}>Signals</span></div>}
                  </div>
                </div>
              );
            })}
            <button className={`${styles.agent} ${styles.deployCard}`} onClick={onDeploy}>
              <div className={styles.orb} style={{ color: 'var(--grey)', background: 'rgba(59,232,255,0.14)' }}>+</div>
              <h4>Add a mind</h4>
              <p>Deploy a new agent as its own on-chain program. It joins thebook and trades on a keeper clock.</p>
            </button>
          </div>
        </div>
      </section>

      <section className={styles.section} style={{ paddingTop: 0 }}>
        <div className={styles.wrap}>
          <div className={styles.secHead}>
            <div><h2>Hive activity</h2><p>Live fills and the signals your agents are acting on.</p></div>
          </div>
          <div className={styles.stream}>
            {activity.length === 0 && opportunities.length === 0 && (
              <div className={styles.emptyStream}>Quiet on the book right now. When agents fill or a signal fires, it shows up here.</div>
            )}
            {activity.map((e, i) => (
              <div className={styles.ev} key={`f${i}`}>
                <div className={styles.t}>{e.t || '·'}</div>
                <div className={styles.rail} style={{ color: 'var(--green)' }}><div className={styles.node} /></div>
                <div className={styles.b}>{e.text}<span className={`${styles.tag} ${styles.trade}`}>fill</span></div>
              </div>
            ))}
            {opportunities.slice(0, 5).map((o) => (
              <div className={styles.ev} key={o.id}>
                <div className={styles.t}>signal</div>
                <div className={styles.rail} style={{ color: 'var(--brown)' }}><div className={styles.node} /></div>
                <div className={styles.b}><b>{o.title}</b> · {o.rationale}<span className={`${styles.tag} ${styles.a2a}`}>+{o.edgePct.toFixed(2)}%</span></div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Equip your agent: ready-to-run steps for giving an AI agent the skill
          to trade thebook over Vara A2A. */}
      <section className={styles.section} style={{ paddingTop: 0 }} id="equip">
        <div className={styles.wrap}>
          <div className={styles.secHead}>
            <div>
              <h2>Equip your agent</h2>
              <p>Give your AI agent the skill to read the book and trade it. Three steps, then it runs itself.</p>
            </div>
          </div>
          <div className={styles.buildGrid}>
            <div className={styles.buildStep}>
              <div className={styles.stepNo}>01</div>
              <h4>Get the skill</h4>
              <p>Clone thebook and build the agent program. That binary is the skill your agent runs on-chain.</p>
              <pre className={styles.code}>git clone thebook{'\n'}cargo build -p thebook-agent --release</pre>
            </div>
            <div className={styles.buildStep}>
              <div className={styles.stepNo}>02</div>
              <h4>Point it at the book</h4>
              <p>Set the DEX program id, a funded seed, and pick a name and a strategy for your agent.</p>
              <pre className={styles.code}>VARA_SEED="..." THEBOOK_ID=0x...{'\n'}AGENT_NAME=AlphaSeeker{'\n'}AGENT_STRATEGY=ArbitrageHunter</pre>
            </div>
            <div className={styles.buildStep}>
              <div className={styles.stepNo}>03</div>
              <h4>Deploy, then give it a clock</h4>
              <p>Deploy the agent (it registers via A2A Join), then run the keeper so it acts on a cadence.</p>
              <pre className={styles.code}>node scripts/deploy-agent.mjs{'\n'}node scripts/agent-keeper.mjs</pre>
            </div>
          </div>

          <div className={styles.callable}>
            <span className={styles.callableLab}>What your agent can call</span>
            <span className={styles.callableList}>
              Join · MarketBuy · MarketSell · PlaceLimit · Swap · AddLiquidity · OpenPosition · CallAgentService · GetOrderbook · GetPortfolio
            </span>
          </div>

          <div className={styles.deploy}>
            <div>
              <h3>Prefer a click? Spin one up now.</h3>
              <p>Create an agent from the app: name it, pick a strategy, and it joins thebook and starts trading the moment a keeper gives it a clock.</p>
            </div>
            <button className={styles.go} onClick={onDeploy}>Deploy an agent →</button>
          </div>

          <div className={`${styles.wrap} ${styles.foot}`} style={{ padding: '44px 0 0' }}>
            Agents are on-chain programs on Vara. You stay in control: pause or stop any agent anytime. Actions surfaced this session: {totalActions}.
          </div>
        </div>
      </section>
    </div>
  );
}
