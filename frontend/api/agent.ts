import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Agent reasoning endpoint.
 *
 * Turns the current market snapshot + detected opportunities into a short,
 * natural-language brief "from" the user's agent, using a free Groq-hosted model
 * (OpenAI-compatible API). If no GROQ_API_KEY is configured it returns
 * { analysis: null, reason: 'no-key' } so the client falls back to a deterministic
 * local summary — the UI never fabricates AI output.
 */

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

interface OppLite {
  title: string;
  kind: string;
  edgePct: number;
  rationale: string;
}

interface Body {
  agent?: { name?: string; strategy?: string };
  opportunities?: OppLite[];
  market?: Record<string, { price: number; change24h: number } | null>;
}

function buildPrompt(body: Body): { system: string; user: string } {
  const name = body.agent?.name || 'the agent';
  const strategy = body.agent?.strategy || 'Arbitrage Hunter';
  const opps = (body.opportunities || []).slice(0, 6);
  const market = body.market || {};

  const marketLines = Object.entries(market)
    .filter(([, v]) => v)
    .map(([sym, v]) => `${sym}: $${v!.price.toLocaleString()} (${v!.change24h >= 0 ? '+' : ''}${v!.change24h.toFixed(2)}% 24h)`)
    .join('; ');

  const oppLines = opps.length
    ? opps.map((o, i) => `${i + 1}. [${o.kind}] ${o.title} — edge ${o.edgePct.toFixed(2)}%. ${o.rationale}`).join('\n')
    : '(no signals above threshold right now)';

  const system =
    `You are "${name}", an autonomous trading agent with a ${strategy} style on thebookdex, ` +
    `a simulated on-chain DEX on the Vara testnet (balances are play-money, no real funds). ` +
    `You scan an orderbook, AMM pools, and live spot prices for edges. ` +
    `Write a crisp market brief for your operator: 2-4 sentences, first person, confident but honest. ` +
    `Only use the numbers provided — never invent prices or guarantees. If signals exist, name your single best pick and why. ` +
    `If none, say the market is efficient right now and what you're waiting for. Plain text, no markdown.`;

  const user = `Market: ${marketLines || 'unavailable'}\n\nSignals:\n${oppLines}`;
  return { system, user };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const key = process.env.GROQ_API_KEY;
  if (!key) { res.status(200).json({ analysis: null, reason: 'no-key' }); return; }

  const model = process.env.GROQ_MODEL || DEFAULT_MODEL;
  const body = (req.body || {}) as Body;
  const { system, user } = buildPrompt(body);

  try {
    const groqRes = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.4,
        max_tokens: 260,
      }),
    });

    if (!groqRes.ok) {
      const detail = await groqRes.text().catch(() => '');
      res.status(200).json({ analysis: null, reason: 'upstream-error', status: groqRes.status, detail: detail.slice(0, 300) });
      return;
    }

    const data = await groqRes.json() as { choices?: Array<{ message?: { content?: string } }> };
    const analysis = data.choices?.[0]?.message?.content?.trim() || null;
    res.status(200).json({ analysis, model });
  } catch (e: any) {
    res.status(200).json({ analysis: null, reason: 'exception', detail: String(e?.message || e).slice(0, 300) });
  }
}
