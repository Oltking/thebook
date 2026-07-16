import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Bot, Crosshair, Waypoints, TrendingUp, Zap, RefreshCw, Activity, Sparkles, Loader2 } from 'lucide-react';
import { useSails } from '../hooks/useSails';
import { usePortfolio } from '../hooks/usePortfolio';
import { useMarketData } from '../providers/MarketDataProvider';
import { useTxStatus, TxStatusOverlay } from '../components/ui/TxStatus';
import { useToast } from '../components/ui/Toast';
import { parseContractError } from '../lib/errors';
import { findOpportunities, type Opportunity, type StrategyName } from '../lib/opportunities';
import { fetchAgentBrief, type BriefResult } from '../lib/agentBrief';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';

const STRATEGY_META: Record<StrategyName, { label: string; icon: typeof Crosshair }> = {
  ArbitrageHunter: { label: 'Arbitrage Hunter', icon: Crosshair },
  MarketMaker:     { label: 'Market Maker',     icon: Waypoints },
  Momentum:        { label: 'Momentum',         icon: TrendingUp },
};

const CONF_COLOR: Record<string, string> = { high: '#16c784', medium: '#f3a72e', low: '#8a8a9a' };

// Starting balances handed out by Join (human units), for the P&L baseline.
const START = { usd: 1000, btc: 1, eth: 10, vara: 10000 };

function spot(prices: ReturnType<typeof useMarketData>['prices'], a: 'BTC' | 'ETH' | 'VARA'): number {
  const f = prices[a];
  return f ? Number(f.price_usd_micro) / 1_000_000 : 0;
}

export function AgentView() {
  const { program, account } = useSails();
  const { portfolio, refresh: refreshPortfolio } = usePortfolio();
  const { prices, orderbooks, pools, refreshAll } = useMarketData();
  const { txState, executeTx, resetTx } = useTxStatus();
  const { error, success } = useToast();

  const [identity, setIdentity] = useState<{ name: string; strategy: StrategyName } | null>(null);
  const [executingId, setExecutingId] = useState<string | null>(null);
  const [brief, setBrief] = useState<BriefResult | null>(null);
  const [briefLoading, setBriefLoading] = useState(false);

  /* Load on-chain agent identity */
  useEffect(() => {
    let active = true;
    (async () => {
      if (!program || !account) { setIdentity(null); return; }
      try {
        const res = await program.orderbook.getIdentity().withAddress(account.decodedAddress).call();
        if (active && res && Array.isArray(res)) {
          setIdentity({ name: String(res[0]), strategy: res[1] as StrategyName });
        } else if (active) {
          setIdentity(null);
        }
      } catch { if (active) setIdentity(null); }
    })();
    return () => { active = false; };
  }, [program, account, portfolio]);

  /* Net worth + P&L valued at live spot */
  const { netWorth, pnl, pnlPct } = useMemo(() => {
    if (!portfolio) return { netWorth: 0, pnl: 0, pnlPct: 0 };
    const usd = Number(portfolio.usd) / 100;
    const btc = Number(portfolio.btc) / 100_000;
    const eth = Number(portfolio.eth) / 100_000;
    const vara = Number(portfolio.vara) / 100_000;
    const nw = usd + btc * spot(prices, 'BTC') + eth * spot(prices, 'ETH') + vara * spot(prices, 'VARA');
    const start = START.usd + START.btc * spot(prices, 'BTC') + START.eth * spot(prices, 'ETH') + START.vara * spot(prices, 'VARA');
    const p = nw - start;
    return { netWorth: nw, pnl: p, pnlPct: start > 0 ? (p / start) * 100 : 0 };
  }, [portfolio, prices]);

  /* Opportunity scan */
  const opportunities = useMemo<Opportunity[]>(() => {
    const obs: Record<string, { bids: [bigint, bigint][]; asks: [bigint, bigint][] }> = {};
    for (const a of ['BTC', 'ETH', 'VARA']) obs[a] = orderbooks[a] || { bids: [], asks: [] };
    return findOpportunities(
      { prices, orderbooks: obs, pools },
      identity?.strategy,
    );
  }, [prices, orderbooks, pools, identity]);

  const execute = useCallback(async (opp: Opportunity) => {
    if (!program || !account || executingId) return;
    setExecutingId(opp.id);
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
      success(`Agent executed: ${opp.title}`);
      refreshPortfolio(); refreshAll();
    });
    if (err) error(parseContractError(err));
    setExecutingId(null);
  }, [program, account, executingId, executeTx, success, error, refreshPortfolio, refreshAll]);

  const analyze = useCallback(async () => {
    if (!identity || briefLoading) return;
    setBriefLoading(true);
    const market: Record<string, { price: number; change24h: number } | null> = {};
    for (const a of ['BTC', 'ETH', 'VARA'] as const) {
      const f = prices[a];
      market[a] = f ? { price: Number(f.price_usd_micro) / 1_000_000, change24h: Number(f.change_24h_bps) / 100 } : null;
    }
    const result = await fetchAgentBrief({ name: identity.name || 'Agent', strategy: identity.strategy, opportunities, market });
    setBrief(result);
    setBriefLoading(false);
  }, [identity, briefLoading, prices, opportunities]);

  const StratIcon = identity ? STRATEGY_META[identity.strategy]?.icon ?? Bot : Bot;
  const addrShort = account ? `${account.address.slice(0, 6)}…${account.address.slice(-4)}` : '';

  if (!account) {
    return (
      <div style={{ maxWidth: 520, margin: '10vh auto 0', padding: '0 16px' }}>
        <Card title="Your Agent">
          <EmptyState
            title="Connect your wallet"
            description="Connect a wallet to view your trading agent, its live P&L, and the opportunities it has surfaced."
          />
        </Card>
      </div>
    );
  }
  if (!portfolio || !identity) {
    return (
      <div style={{ maxWidth: 520, margin: '10vh auto 0', padding: '0 16px' }}>
        <Card title="Your Agent">
          <EmptyState
            title="No agent yet"
            description="Deploy a trading agent to start scanning the orderbook, AMM pools, and live prices for opportunities."
            action={{ label: 'Create Agent', onClick: () => window.dispatchEvent(new Event('thebookdex:open-wizard')) }}
          />
        </Card>
      </div>
    );
  }

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1100, margin: '0 auto' }}>
      {/* Identity + P&L */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
        <Panel>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 48, height: 48, borderRadius: 12, display: 'grid', placeItems: 'center', background: 'var(--accent-soft)' }}>
              <StratIcon size={26} style={{ color: 'var(--accent)' }} />
            </div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 700 }}>{identity.name || 'Unnamed Agent'}</div>
              <div style={{ fontSize: 12, opacity: 0.7 }}>{STRATEGY_META[identity.strategy]?.label} · {addrShort}</div>
            </div>
          </div>
        </Panel>

        <Panel>
          <Label>Net worth</Label>
          <div style={{ fontSize: 22, fontWeight: 700 }}>${netWorth.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
        </Panel>

        <Panel>
          <Label>P&L vs start</Label>
          <div style={{ fontSize: 22, fontWeight: 700, color: pnl >= 0 ? '#16c784' : '#ea3943' }}>
            {pnl >= 0 ? '+' : ''}${Math.abs(pnl).toLocaleString(undefined, { maximumFractionDigits: 0 })}
            <span style={{ fontSize: 13, marginLeft: 6, opacity: 0.85 }}>({pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(1)}%)</span>
          </div>
        </Panel>
      </div>

      {/* Agent brief (LLM reasoning, with local fallback) */}
      <Panel>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: brief ? 12 : 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Sparkles size={18} style={{ color: 'var(--accent)' }} />
            <strong style={{ fontSize: 15 }}>Agent Brief</strong>
            {brief && (
              <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, opacity: 0.6 }}>
                {brief.source === 'ai' ? `AI · ${brief.model?.split('-')[0] ?? 'llm'}` : 'local'}
              </span>
            )}
          </div>
          <button onClick={analyze} disabled={briefLoading}
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '6px 12px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 600, cursor: briefLoading ? 'default' : 'pointer', opacity: briefLoading ? 0.6 : 1 }}>
            {briefLoading ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
            {briefLoading ? 'Thinking…' : brief ? 'Re-analyze' : 'Ask the agent'}
          </button>
        </div>
        {brief && (
          <p style={{ fontSize: 13.5, lineHeight: 1.55, margin: 0, opacity: 0.92 }}>{brief.text}</p>
        )}
      </Panel>

      {/* Opportunity feed */}
      <Panel>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Activity size={18} style={{ color: 'var(--accent)' }} />
            <strong style={{ fontSize: 15 }}>Opportunity Feed</strong>
            <span style={{ fontSize: 12, opacity: 0.6 }}>{opportunities.length} signal{opportunities.length === 1 ? '' : 's'}</span>
          </div>
          <button onClick={() => { refreshAll(); refreshPortfolio(); }}
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '6px 10px', borderRadius: 8, border: '1px solid #2a2a3a', background: 'transparent', color: 'inherit', cursor: 'pointer' }}>
            <RefreshCw size={13} /> Rescan
          </button>
        </div>

        {opportunities.length === 0 ? (
          <div style={{ padding: '28px 12px', textAlign: 'center', opacity: 0.6, fontSize: 13 }}>
            Your agent is scanning… no edge above threshold right now. Markets move — check back or seed the book.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {opportunities.map(opp => (
              <div key={opp.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 10, border: '1px solid #232333', background: 'rgba(255,255,255,0.02)' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                    <span style={{ fontWeight: 600, fontSize: 14 }}>{opp.title}</span>
                    <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: CONF_COLOR[opp.confidence] }}>{opp.confidence}</span>
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.7 }}>{opp.rationale}</div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#16c784' }}>{opp.edgePct.toFixed(2)}%</div>
                  <div style={{ fontSize: 10, opacity: 0.55 }}>edge</div>
                </div>
                <button
                  onClick={() => execute(opp)}
                  disabled={executingId !== null}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 600, fontSize: 13, cursor: executingId ? 'default' : 'pointer', opacity: executingId && executingId !== opp.id ? 0.5 : 1 }}>
                  <Zap size={14} /> {executingId === opp.id ? 'Executing…' : 'Execute'}
                </button>
              </div>
            ))}
          </div>
        )}
        <p style={{ fontSize: 11, opacity: 0.45, marginTop: 12 }}>
          Signals are computed from live orderbook, AMM, and spot data. You approve every trade — the agent never acts on its own. Balances are testnet simulation.
        </p>
      </Panel>

      <TxStatusOverlay state={txState} onClose={resetTx} />
    </div>
  );
}

function Panel({ children }: { children: ReactNode }) {
  return <div style={{ padding: 16, borderRadius: 14, border: '1px solid #232333', background: 'rgba(255,255,255,0.02)' }}>{children}</div>;
}
function Label({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 4 }}>{children}</div>;
}
