import type { Opportunity, StrategyName } from './opportunities';

export interface BriefInput {
  name: string;
  strategy: StrategyName;
  opportunities: Opportunity[];
  market: Record<string, { price: number; change24h: number } | null>;
}

export interface BriefResult {
  text: string;
  source: 'ai' | 'local';
  model?: string;
}

const STRATEGY_FLAVOR: Record<StrategyName, string> = {
  ArbitrageHunter: 'I hunt price gaps between the book, the pools, and spot.',
  MarketMaker: 'I earn the spread by quoting both sides.',
  Momentum: 'I ride assets that are moving.',
};

/** Deterministic brief used when the LLM endpoint has no key or is unreachable. */
export function localBrief(input: BriefInput): string {
  const { name, strategy, opportunities: opps } = input;
  if (opps.length === 0) {
    return `${name}: the market looks efficient right now — no edge above my threshold. ${STRATEGY_FLAVOR[strategy]} I'm watching orderbook spreads and AMM pools and will surface a signal the moment one opens.`;
  }
  const top = opps[0];
  const others = opps.length - 1;
  return `${name}: I found ${opps.length} signal${opps.length === 1 ? '' : 's'}. My best pick is "${top.title}" — a ${top.edgePct.toFixed(2)}% edge. ${top.rationale}${others > 0 ? ` ${others} more on the board.` : ''} Balances are simulated, so I'll execute on your approval.`;
}

export async function fetchAgentBrief(input: BriefInput): Promise<BriefResult> {
  try {
    const res = await fetch('/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: { name: input.name, strategy: input.strategy },
        opportunities: input.opportunities.slice(0, 6).map(o => ({
          title: o.title, kind: o.kind, edgePct: o.edgePct, rationale: o.rationale,
        })),
        market: input.market,
      }),
    });
    if (res.ok) {
      const data = await res.json() as { analysis?: string | null; model?: string };
      if (data.analysis) return { text: data.analysis, source: 'ai', model: data.model };
    }
  } catch { /* fall through to local */ }
  return { text: localBrief(input), source: 'local' };
}
