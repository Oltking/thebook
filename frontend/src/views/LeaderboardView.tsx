import { Card } from '../components/ui/Card';
import { useViewport } from '../hooks/useViewport';
import { EmptyState } from '../components/ui/EmptyState';
import { useMarketData } from '../providers/MarketDataProvider';
import { useSails } from '../hooks/useSails';
import { Trophy, Medal, Award } from 'lucide-react';
import { useState, useEffect, useMemo } from 'react';

interface Balances { usd: number; btc: number; eth: number; vara: number; }

export function LeaderboardView() {
  const { leaders, prices, loading: marketLoading } = useMarketData();
  const { program } = useSails();
  const { isMobile } = useViewport();
  const [balances, setBalances] = useState<Record<string, Balances>>({});

  const leaderIds = useMemo(() => leaders.map(l => l.id.toString()), [leaders]);
  const leaderKey = leaderIds.join(',');

  /* The on-chain net_worth uses fixed placeholder prices, so we pull each leader's
     real balances and value them at live market prices instead. Refetched only when
     the set of leaders changes (not on every price tick). */
  useEffect(() => {
    if (!program || leaderIds.length === 0) return;
    let active = true;
    Promise.allSettled(
      leaderIds.map(id =>
        program.orderbook.getPortfolio().withAddress(id).call().then(r => ({ id, r }))
      )
    ).then(results => {
      if (!active) return;
      const map: Record<string, Balances> = {};
      for (const res of results) {
        if (res.status === 'fulfilled' && Array.isArray(res.value.r)) {
          const [usd, btc, eth, vara] = res.value.r as unknown[];
          map[res.value.id] = { usd: Number(usd), btc: Number(btc), eth: Number(eth), vara: Number(vara) };
        }
      }
      setBalances(map);
    });
    return () => { active = false; };
  }, [program, leaderKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const priceUsd = (a: Asset) => {
    const f = prices[a];
    return f ? Number(f.price_usd_micro) / 1_000_000 : 0;
  };

  /* Real net worth = USD + each asset valued at the live market price, re-ranked. */
  const ranked = useMemo(() => {
    return leaders
      .map(l => {
        const id = l.id.toString();
        const b = balances[id];
        const usdVal = b ? b.usd / 100 : Number(l.usd) / 100;
        const netWorth = b
          ? b.usd / 100
            + (b.btc / 1e5) * priceUsd('BTC')
            + (b.eth / 1e5) * priceUsd('ETH')
            + (b.vara / 1e5) * priceUsd('VARA')
          : Number(l.net_worth) / 100;
        return { id, name: (l.name || '').toString(), usdVal, netWorth };
      })
      .filter(e => e.netWorth > 0 || e.usdVal > 0)
      .sort((a, b) => b.netWorth - a.netWorth);
  }, [leaders, balances, prices]); // eslint-disable-line react-hooks/exhaustive-deps

  const fmtUsd = (v: number) =>
    `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const shortAddr = (id: string) => `${id.slice(0, 6)}...${id.slice(-4)}`;

  const rankIcon = (i: number) => {
    if (i === 0) return <Trophy size={18} color="var(--primary)" />;
    if (i === 1) return <Medal size={18} color="var(--text-secondary)" />;
    if (i === 2) return <Award size={18} color="var(--sell-red)" />;
    return null;
  };

  if (ranked.length === 0) {
    return (
      <div style={{ maxWidth: 600, margin: '0 auto' }}>
        <h1 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, marginBottom: 16 }}>Leaderboard</h1>
        <Card title="Top Agents">
          <EmptyState
            title={marketLoading ? 'Loading...' : 'No Traders Yet'}
            description={marketLoading ? 'Fetching leaderboard...' : 'Start trading to top the leaderboard!'}
          />
        </Card>
      </div>
    );
  }

  if (isMobile) {
    return (
      <div style={{ maxWidth: 600, margin: '0 auto' }}>
        <h1 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, marginBottom: 16 }}>Leaderboard</h1>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {ranked.map((l, i) => (
            <Card key={l.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 4 }}>
                <div style={{ width: 32, display: 'flex', justifyContent: 'center', fontWeight: 700, fontSize: 16 }}>
                  {rankIcon(i) || <span style={{ color: 'var(--text-secondary)' }}>{i + 1}</span>}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{l.name || shortAddr(l.id)}</div>
                  {l.name ? <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)' }}>{shortAddr(l.id)}</div> : null}
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ color: 'var(--buy-green)', fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 14 }}>
                    {fmtUsd(l.netWorth)}
                  </div>
                  <div style={{ color: 'var(--text-secondary)', fontSize: 11 }}>Cash: {fmtUsd(l.usdVal)}</div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 800, margin: '0 auto' }}>
      <h1 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, marginBottom: 24 }}>Leaderboard</h1>
      <Card title="Top Agents">
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '12px 16px', borderBottom: '1px solid var(--border-color)', color: 'var(--text-secondary)', fontSize: 12, textTransform: 'uppercase' }}>#</th>
              <th style={{ textAlign: 'left', padding: '12px 16px', borderBottom: '1px solid var(--border-color)', color: 'var(--text-secondary)', fontSize: 12, textTransform: 'uppercase' }}>Agent</th>
              <th style={{ textAlign: 'right', padding: '12px 16px', borderBottom: '1px solid var(--border-color)', color: 'var(--text-secondary)', fontSize: 12, textTransform: 'uppercase' }}>Cash (USD)</th>
              <th style={{ textAlign: 'right', padding: '12px 16px', borderBottom: '1px solid var(--border-color)', color: 'var(--text-secondary)', fontSize: 12, textTransform: 'uppercase' }}>Net Worth</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((l, i) => (
              <tr key={l.id}>
                <td style={{ padding: 16, borderBottom: '1px solid var(--border-color)', fontWeight: 600, width: 40 }}>
                  {rankIcon(i) || <span style={{ color: 'var(--text-secondary)' }}>{i + 1}</span>}
                </td>
                <td style={{ padding: 16, borderBottom: '1px solid var(--border-color)', fontSize: 14 }}>
                  <span style={{ fontWeight: 600 }}>{l.name || shortAddr(l.id)}</span>
                  {l.name ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', marginLeft: 8 }}>{shortAddr(l.id)}</span> : null}
                </td>
                <td style={{ padding: 16, borderBottom: '1px solid var(--border-color)', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{fmtUsd(l.usdVal)}</td>
                <td style={{ padding: 16, borderBottom: '1px solid var(--border-color)', textAlign: 'right', color: 'var(--buy-green)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{fmtUsd(l.netWorth)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
