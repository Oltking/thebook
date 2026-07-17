import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, Sparkles, Send, Bot, TrendingUp, Wallet, Zap, Loader2, Gauge } from 'lucide-react';
import { useSails } from '../hooks/useSails';
import { usePortfolio } from '../hooks/usePortfolio';
import { useMarketData } from '../providers/MarketDataProvider';
import { useToast } from '../components/ui/Toast';
import { useTxStatus, TxStatusOverlay } from '../components/ui/TxStatus';
import { parseContractError } from '../lib/errors';
import { findOpportunities, type Opportunity, type StrategyName } from '../lib/opportunities';
import { fetchAgentBrief } from '../lib/agentBrief';
import { resolveIdentity } from '../lib/identity';
import styles from './HomeView.module.css';

interface HomeViewProps {
  onNavigate: (tab: string) => void;
}

const SUGGESTIONS = [
  'Find me an opportunity',
  "How's my portfolio?",
  'What should I trade now?',
  'Explain perps in one line',
];

const CONF: Record<string, string> = { high: styles.confHigh, medium: styles.confMed, low: styles.confLow };

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export function HomeView({ onNavigate }: HomeViewProps) {
  const { program, account } = useSails();
  const { portfolio, refresh: refreshPortfolio } = usePortfolio();
  const { prices, orderbooks, pools, refreshAll } = useMarketData();
  const { success, error } = useToast();
  const { txState, executeTx, resetTx } = useTxStatus();

  const [identity, setIdentity] = useState<{ name: string; strategy: StrategyName } | null>(null);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const [reply, setReply] = useState<string | null>(null);
  const [execId, setExecId] = useState<string | null>(null);

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

  const netWorth = useMemo(() => {
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

  const ask = useCallback(async (q: string) => {
    const text = q.trim();
    if (!text || thinking) return;
    setInput('');
    setThinking(true);
    setReply(null);
    const market: Record<string, { price: number; change24h: number } | null> = {};
    for (const a of ['BTC', 'ETH', 'VARA'] as const) {
      const f = prices[a];
      market[a] = f ? { price: Number(f.price_usd_micro) / 1_000_000, change24h: Number(f.change_24h_bps) / 100 } : null;
    }
    const res = await fetchAgentBrief({
      name: identity?.name || 'Your agent',
      strategy: identity?.strategy || 'ArbitrageHunter',
      opportunities,
      market,
    });
    setReply(res.text);
    setThinking(false);
  }, [thinking, prices, identity, opportunities]);

  const execute = useCallback(async (opp: Opportunity) => {
    if (!program || !account || execId) return;
    setExecId(opp.id);
    const a = opp.action;
    const buildTx = () => {
      switch (a.type) {
        case 'marketBuy':  return program.orderbook.marketBuy(a.asset, a.qtyContract);
        case 'marketSell': return program.orderbook.marketSell(a.asset, a.qtyContract);
        case 'placeLimit': return program.orderbook.placeLimit(a.side!, a.asset, a.priceContract!, a.qtyContract);
        case 'swap':       return program.amm.swap(a.poolId!, a.assetIn!, a.amountInContract!, 1n);
      }
    };
    const err = await executeTx(buildTx as any, account, () => {
      success(`Executed: ${opp.title}`);
      refreshPortfolio(); refreshAll();
    });
    if (err) error(parseContractError(err));
    setExecId(null);
  }, [program, account, execId, executeTx, success, error, refreshPortfolio, refreshAll]);

  const fmtUsd = (v: number) => `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const name = identity?.name || 'trader';

  const quick = [
    { id: 'trade', label: 'Trade', icon: TrendingUp },
    { id: 'swap', label: 'Swap', icon: Zap },
    { id: 'futures', label: 'Futures', icon: Gauge },
    { id: 'portfolio', label: 'Portfolio', icon: Wallet },
  ];

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <div className={styles.eyebrow}>
          <span className={styles.dot} /> thebookdex · your on-chain trading agent
        </div>
        <h1 className={styles.hero}>
          {greeting()}, {name}.<br />
          <span className={styles.heroDim}>What should your agent do?</span>
        </h1>

        {/* Command bar */}
        <form className={styles.command} onSubmit={(e) => { e.preventDefault(); ask(input); }}>
          <Sparkles size={18} className={styles.cmdIcon} />
          <input
            className={styles.cmdInput}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask your agent, or type a command…"
            aria-label="Ask your agent"
          />
          <button type="submit" className={styles.cmdSend} disabled={thinking || !input.trim()} aria-label="Send">
            {thinking ? <Loader2 size={18} className={styles.spin} /> : <Send size={18} />}
          </button>
        </form>

        <div className={styles.chips}>
          {SUGGESTIONS.map((s) => (
            <button key={s} className={styles.chip} onClick={() => ask(s)} disabled={thinking}>{s}</button>
          ))}
        </div>

        {/* Agent reply */}
        {(thinking || reply) && (
          <div className={styles.reply}>
            <div className={styles.replyAvatar}><Bot size={16} /></div>
            <div className={styles.replyBody}>
              {thinking ? <span className={styles.thinking}>Your agent is thinking…</span> : reply}
            </div>
          </div>
        )}

        {/* Snapshot */}
        <div className={styles.snapshot}>
          {account && portfolio ? (
            <>
              <div className={styles.stat}>
                <span className={styles.statLabel}>Net worth</span>
                <span className={styles.statValue}>{fmtUsd(netWorth)}</span>
              </div>
              <div className={styles.stat}>
                <span className={styles.statLabel}>Cash</span>
                <span className={styles.statValue}>{fmtUsd(Number(portfolio.usd) / 100)}</span>
              </div>
              <div className={styles.stat}>
                <span className={styles.statLabel}>Live signals</span>
                <span className={styles.statValue}>{opportunities.length}</span>
              </div>
            </>
          ) : (
            <button className={styles.connectCard} onClick={() => window.dispatchEvent(new Event('thebookdex:open-wizard'))}>
              <Wallet size={18} />
              <div>
                <div className={styles.connectTitle}>Deploy your agent</div>
                <div className={styles.connectSub}>Connect a wallet and create an agent to begin.</div>
              </div>
              <ArrowUpRight size={16} className={styles.connectArrow} />
            </button>
          )}
        </div>

        {/* Opportunities */}
        <div className={styles.section}>
          <div className={styles.sectionHead}>
            <span>Signals your agent is watching</span>
            <button className={styles.link} onClick={() => onNavigate('agent')}>Open agent →</button>
          </div>
          {opportunities.length === 0 ? (
            <div className={styles.empty}>
              The market looks efficient right now — no edge above threshold. Your agent will surface a signal the moment one opens.
            </div>
          ) : (
            <div className={styles.oppGrid}>
              {opportunities.slice(0, 4).map((o) => (
                <div key={o.id} className={styles.opp}>
                  <div className={styles.oppTop}>
                    <span className={`${styles.conf} ${CONF[o.confidence]}`}>{o.confidence}</span>
                    <span className={styles.oppEdge}>+{o.edgePct.toFixed(2)}%</span>
                  </div>
                  <div className={styles.oppTitle}>{o.title}</div>
                  <div className={styles.oppRationale}>{o.rationale}</div>
                  <button
                    className={styles.oppExec}
                    onClick={() => execute(o)}
                    disabled={!account || execId === o.id}
                  >
                    {execId === o.id ? 'Executing…' : 'Execute'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Quick actions */}
        <div className={styles.quick}>
          {quick.map((q) => {
            const Icon = q.icon;
            return (
              <button key={q.id} className={styles.quickBtn} onClick={() => onNavigate(q.id)}>
                <Icon size={17} />
                {q.label}
              </button>
            );
          })}
        </div>
      </div>
      <TxStatusOverlay state={txState} onClose={resetTx} />
    </div>
  );
}
