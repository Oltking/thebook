/**
 * Opportunity engine - the agent's "market scanner".
 *
 * Pure functions that turn the live market snapshot (orderbooks, off-chain spot
 * prices, AMM pools) into a ranked list of actionable trade signals. No I/O, no
 * React - so it's trivially testable and the dashboard just renders + executes.
 *
 * Scaling between human units and the contract's integer units:
 *   price : contract unit = micro-dollar → usd = priceContract / 1_000_000
 *   qty   : contract unit = 1e-5 asset   → asset = qtyContract / 100_000
 *   usd   : contract unit = micro-dollar → dollars = usd / 1_000_000
 */

// Micro-dollar price/usd unit ($1 = 1_000_000). PRICE_SCALE is a *divisor* now.
export const PRICE_SCALE = 1_000_000;
export const QTY_SCALE = 100_000;
export const USD_SCALE = 1_000_000;

/** Minimum edge (%) before we bother surfacing a signal. */
const MIN_EDGE_PCT = 0.5;
/** Spread (%) above which an empty/wide book is a market-making opportunity. */
const WIDE_SPREAD_PCT = 2.5;

export type OppKind = 'arb-buy' | 'arb-sell' | 'amm-swap' | 'market-make';
export type Confidence = 'high' | 'medium' | 'low';
export type StrategyName = 'ArbitrageHunter' | 'MarketMaker' | 'Momentum';

export interface AgentAction {
  type: 'marketBuy' | 'marketSell' | 'placeLimit' | 'swap';
  asset: Asset;
  side?: Side;
  qtyContract: bigint;
  priceContract?: bigint;
  poolId?: bigint;
  assetIn?: Asset;
  amountInContract?: bigint;
}

export interface Opportunity {
  id: string;
  kind: OppKind;
  asset: Asset;
  title: string;
  rationale: string;
  edgePct: number;
  estProfitUsd: number;
  confidence: Confidence;
  action: AgentAction;
}

export interface MarketSnapshot {
  prices: Record<Asset, PriceFeed | null>;
  orderbooks: Record<string, { bids: [bigint, bigint][]; asks: [bigint, bigint][] }>;
  pools: Pool[];
}

const ASSETS: Asset[] = ['BTC', 'ETH', 'VARA'];

function spotUsd(feed: PriceFeed | null): number | null {
  if (!feed) return null;
  const v = Number(feed.price_usd_micro) / 1_000_000;
  return v > 0 ? v : null;
}

function confFromEdge(edge: number): Confidence {
  if (edge >= 2) return 'high';
  if (edge >= 1) return 'medium';
  return 'low';
}

/** Strategy bias: nudge the ranking toward the persona the user picked. */
function strategyBoost(kind: OppKind, strategy?: StrategyName): number {
  if (!strategy) return 0;
  if (strategy === 'ArbitrageHunter' && (kind === 'arb-buy' || kind === 'arb-sell' || kind === 'amm-swap')) return 0.75;
  if (strategy === 'MarketMaker' && kind === 'market-make') return 0.75;
  if (strategy === 'Momentum' && (kind === 'arb-buy' || kind === 'arb-sell')) return 0.4;
  return 0;
}

export function findOpportunities(snap: MarketSnapshot, strategy?: StrategyName): Opportunity[] {
  const out: Opportunity[] = [];

  for (const asset of ASSETS) {
    const spot = spotUsd(snap.prices[asset]);
    const ob = snap.orderbooks[asset];
    if (!ob) continue;

    const bestAsk = ob.asks[0]; // lowest ask  [priceContract, qtyContract]
    const bestBid = ob.bids[0]; // highest bid

    // ── Orderbook arbitrage vs off-chain spot ──
    if (spot && bestAsk && bestAsk[1] > 0n) {
      const askUsd = Number(bestAsk[0]) / PRICE_SCALE;
      if (askUsd > 0 && askUsd < spot) {
        const edge = ((spot - askUsd) / spot) * 100;
        if (edge >= MIN_EDGE_PCT) {
          const qtyAsset = Number(bestAsk[1]) / QTY_SCALE;
          out.push({
            id: `arb-buy-${asset}`,
            kind: 'arb-buy',
            asset,
            title: `${asset} is below spot on the book`,
            rationale: `Best ask $${fmt(askUsd)} is ${edge.toFixed(2)}% under spot $${fmt(spot)}. Buy on the book, value at spot.`,
            edgePct: edge,
            estProfitUsd: (spot - askUsd) * qtyAsset,
            confidence: confFromEdge(edge),
            action: { type: 'marketBuy', asset, qtyContract: bestAsk[1] },
          });
        }
      }
    }

    if (spot && bestBid && bestBid[1] > 0n) {
      const bidUsd = Number(bestBid[0]) / PRICE_SCALE;
      if (bidUsd > spot) {
        const edge = ((bidUsd - spot) / spot) * 100;
        if (edge >= MIN_EDGE_PCT) {
          const qtyAsset = Number(bestBid[1]) / QTY_SCALE;
          out.push({
            id: `arb-sell-${asset}`,
            kind: 'arb-sell',
            asset,
            title: `${asset} bid is above spot`,
            rationale: `Best bid $${fmt(bidUsd)} is ${edge.toFixed(2)}% over spot $${fmt(spot)}. Sell into the book.`,
            edgePct: edge,
            estProfitUsd: (bidUsd - spot) * qtyAsset,
            confidence: confFromEdge(edge),
            action: { type: 'marketSell', asset, qtyContract: bestBid[1] },
          });
        }
      }
    }

    // ── Market-making: empty or very wide book around spot ──
    if (spot) {
      const hasBid = !!bestBid && bestBid[1] > 0n;
      const hasAsk = !!bestAsk && bestAsk[1] > 0n;
      const bidUsd = hasBid ? Number(bestBid![0]) / PRICE_SCALE : 0;
      const askUsd = hasAsk ? Number(bestAsk![0]) / PRICE_SCALE : 0;
      const spreadPct = hasBid && hasAsk && bidUsd > 0 ? ((askUsd - bidUsd) / spot) * 100 : Infinity;
      if (!hasBid || !hasAsk || spreadPct > WIDE_SPREAD_PCT) {
        // Quote a modest order at spot (in micro-dollars).
        const priceContract = BigInt(Math.max(1, Math.round(spot * PRICE_SCALE)));
        const qtyAsset = asset === 'BTC' ? 0.001 : asset === 'ETH' ? 0.01 : 100;
        const qtyContract = BigInt(Math.round(qtyAsset * QTY_SCALE));
        // If only one side exists, post the missing side; else post a buy at spot.
        const side: Side = hasAsk && !hasBid ? 'Buy' : !hasAsk && hasBid ? 'Sell' : 'Buy';
        out.push({
          id: `mm-${asset}`,
          kind: 'market-make',
          asset,
          title: `${asset} book is ${!hasBid || !hasAsk ? 'one-sided' : 'wide'}`,
          rationale: `${!hasBid || !hasAsk ? 'Liquidity is missing on one side' : `Spread is ${spreadPct.toFixed(1)}%`}. Post a ${side.toLowerCase()} limit at spot to earn the spread.`,
          edgePct: Math.min(spreadPct === Infinity ? WIDE_SPREAD_PCT : spreadPct, 5),
          estProfitUsd: 0,
          confidence: 'low',
          action: { type: 'placeLimit', asset, side, qtyContract, priceContract },
        });
      }
    }
  }

  // ── AMM mispricing vs spot ──
  for (const pool of snap.pools) {
    const a = pool.asset_a, b = pool.asset_b;
    const Ra = Number(pool.reserve_a), Rb = Number(pool.reserve_b);
    const spotA = spotUsd(snap.prices[a]);
    const spotB = spotUsd(snap.prices[b]);
    if (Ra <= 0 || Rb <= 0 || !spotA || !spotB) continue;

    // USD price of asset_a implied by the pool, using asset_b's spot as the anchor.
    const poolImpliedUsdA = (Rb / Ra) * spotB; // reserves share the same 1e5 scale, so the ratio is unit-free
    const edge = ((spotA - poolImpliedUsdA) / spotA) * 100;
    if (Math.abs(edge) < MIN_EDGE_PCT) continue;

    if (edge > 0) {
      // asset_a is cheap in the pool → buy a by swapping in b
      const amountInB = BigInt(Math.max(1, Math.round(Rb * 0.01)));
      out.push({
        id: `amm-${Number(pool.id)}-buyA`,
        kind: 'amm-swap',
        asset: a,
        title: `${a} is cheap in pool #${Number(pool.id)}`,
        rationale: `Pool prices ${a} ${edge.toFixed(2)}% under spot. Swap ${b}→${a} to capture it.`,
        edgePct: edge,
        estProfitUsd: 0,
        confidence: confFromEdge(edge),
        action: { type: 'swap', asset: a, poolId: pool.id as unknown as bigint, assetIn: b, amountInContract: amountInB, qtyContract: 0n },
      });
    } else {
      const amountInA = BigInt(Math.max(1, Math.round(Ra * 0.01)));
      out.push({
        id: `amm-${Number(pool.id)}-sellA`,
        kind: 'amm-swap',
        asset: a,
        title: `${a} is rich in pool #${Number(pool.id)}`,
        rationale: `Pool prices ${a} ${Math.abs(edge).toFixed(2)}% over spot. Swap ${a}→${b} to capture it.`,
        edgePct: Math.abs(edge),
        estProfitUsd: 0,
        confidence: confFromEdge(Math.abs(edge)),
        action: { type: 'swap', asset: a, poolId: pool.id as unknown as bigint, assetIn: a, amountInContract: amountInA, qtyContract: 0n },
      });
    }
  }

  // Rank: edge plus a nudge toward the agent's chosen strategy.
  return out.sort(
    (x, y) => (y.edgePct + strategyBoost(y.kind, strategy)) - (x.edgePct + strategyBoost(x.kind, strategy)),
  );
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
