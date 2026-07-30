import { useEffect, useRef, useState, useMemo } from 'react';
import {
  createChart, ColorType, LineStyle, CrosshairMode,
  CandlestickSeries, LineSeries, HistogramSeries,
  type IChartApi, type ISeriesApi, type UTCTimestamp,
} from 'lightweight-charts';
import styles from './TradeChart.module.css';

interface TradeChartProps {
  trades: { price: bigint; qty: bigint }[];
  oraclePrice: number;
  priceHistory: import('../../providers/MarketDataProvider').PricePoint[];
  bids: [bigint, bigint][];
  asks: [bigint, bigint][];
  asset: string;
}

type ChartView = 'price' | 'depth';
type Timeframe = '1H' | '4H' | '1D' | '1W' | '1M' | '1Y';
const TIMEFRAMES: Timeframe[] = ['1H', '4H', '1D', '1W', '1M', '1Y'];

const CHART_BG = '#0d1117';
const PRIMARY   = '#00b272';

/* ── Market data fetching ── */

interface OHLCV { time: UTCTimestamp; open: number; high: number; low: number; close: number; volume: number; }

const BINANCE_SYMBOLS: Record<string, string> = { BTC: 'BTCUSDT', ETH: 'ETHUSDT' };
const COINGECKO_IDS:  Record<string, string> = { BTC: 'bitcoin', ETH: 'ethereum', VARA: 'vara-network' };

const TIMEFRAME_CONFIG: Record<Timeframe, { interval: string; limit: number; cgDays: number }> = {
  '1H': { interval: '1m',  limit: 60,  cgDays: 1   },
  '4H': { interval: '5m',  limit: 48,  cgDays: 1   },
  '1D': { interval: '15m', limit: 96,  cgDays: 1   },
  '1W': { interval: '1h',  limit: 168, cgDays: 7   },
  '1M': { interval: '4h',  limit: 180, cgDays: 30  },
  '1Y': { interval: '1d',  limit: 365, cgDays: 365 },
};

/* Simple module-level cache so we don't re-fetch on every 5s poll */
const ohlcCache = new Map<string, { data: OHLCV[]; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000;

async function fetchBinance(symbol: string, interval: string, limit: number): Promise<OHLCV[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const r = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
      { signal: ctrl.signal }
    );
    if (!r.ok) throw new Error('Binance error');
    const raw: any[][] = await r.json();
    return raw.map(k => ({
      time: Math.floor(Number(k[0]) / 1000) as UTCTimestamp,
      open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
    }));
  } finally { clearTimeout(t); }
}

async function fetchCoinGecko(coinId: string, days: number): Promise<OHLCV[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const r = await fetch(
      `https://api.coingecko.com/api/v3/coins/${coinId}/ohlc?vs_currency=usd&days=${days}`,
      { signal: ctrl.signal }
    );
    if (!r.ok) throw new Error('CoinGecko error');
    const raw: number[][] = await r.json();
    return raw.map(k => ({
      time: Math.floor(k[0] / 1000) as UTCTimestamp,
      open: k[1], high: k[2], low: k[3], close: k[4], volume: 0,
    }));
  } finally { clearTimeout(t); }
}

async function fetchMarketData(asset: string, tf: Timeframe): Promise<OHLCV[]> {
  const key = `${asset}-${tf}`;
  const cached = ohlcCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const { interval, limit, cgDays } = TIMEFRAME_CONFIG[tf];
  const binSym = BINANCE_SYMBOLS[asset];
  const cgId   = COINGECKO_IDS[asset];

  let data: OHLCV[] = [];

  /* Try Binance first, fall back to CoinGecko on any failure */
  if (binSym) {
    try { data = await fetchBinance(binSym, interval, limit); } catch { /* fallthrough */ }
  }
  if (data.length === 0 && cgId) {
    try { data = await fetchCoinGecko(cgId, cgDays); } catch { /* fallthrough */ }
  }

  if (data.length > 0) ohlcCache.set(key, { data, ts: Date.now() });
  return data;
}

/* ── Depth canvas ── */

interface DepthPoint { price: number; cum: number }

function drawDepth(canvas: HTMLCanvasElement, bids: DepthPoint[], asks: DepthPoint[]) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  const W = rect.width, H = rect.height;
  const PAD = { top: 24, right: 16, bottom: 36, left: 68 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  ctx.fillStyle = CHART_BG; ctx.fillRect(0, 0, W, H);

  const all = [...bids.map(b => b.price), ...asks.map(a => a.price)];
  if (!all.length) {
    ctx.fillStyle = '#848e9c'; ctx.font = '13px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('No open orders yet', W / 2, H / 2); return;
  }
  const minP = all[0], maxP = all[all.length - 1], span = maxP - minP || 1;
  const maxCum = Math.max(bids.at(-1)?.cum ?? 0, asks.at(-1)?.cum ?? 0) || 1;
  const vS = plotH / maxCum;
  const xP = (p: number) => PAD.left + ((p - minP) / span) * plotW;
  const yC = (c: number) => PAD.top + plotH - c * vS;

  ctx.strokeStyle = '#1a1f26'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = PAD.top + (plotH / 4) * i;
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(W - PAD.right, y); ctx.stroke();
  }

  const area = (pts: DepthPoint[], fill: string, stroke: string) => {
    if (pts.length < 1) return;
    ctx.beginPath();
    ctx.moveTo(xP(pts[0].price), PAD.top + plotH);
    for (const p of pts) ctx.lineTo(xP(p.price), yC(p.cum));
    ctx.lineTo(xP(pts[pts.length - 1].price), PAD.top + plotH);
    ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
    ctx.strokeStyle = stroke; ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach((p, i) => i === 0 ? ctx.moveTo(xP(p.price), yC(p.cum)) : ctx.lineTo(xP(p.price), yC(p.cum)));
    ctx.stroke();
  };
  area(bids, 'rgba(14,203,129,0.15)', '#0ecb81');
  area(asks, 'rgba(246,70,93,0.15)',  '#f6465d');

  if (bids.length && asks.length) {
    const mid = asks[0].price;
    ctx.strokeStyle = `${PRIMARY}99`; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(xP(mid), PAD.top); ctx.lineTo(xP(mid), PAD.top + plotH); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = PRIMARY; ctx.font = 'bold 10px monospace'; ctx.textAlign = 'center';
    ctx.fillText(`$${mid.toFixed(0)}`, xP(mid), PAD.top - 6);
  }

  ctx.fillStyle = '#848e9c'; ctx.font = '10px monospace';
  ctx.textAlign = 'center';
  const lc = Math.min(5, all.length);
  for (let i = 0; i < lc; i++) {
    const p = all[Math.floor((all.length - 1) * (i / Math.max(lc - 1, 1)))];
    ctx.fillText(`$${p >= 1000 ? p.toLocaleString(undefined, {maximumFractionDigits: 0}) : p.toFixed(2)}`, xP(p), H - 8);
  }
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const v = (maxCum / 4) * i;
    ctx.fillText(v >= 1000 ? `${(v/1000).toFixed(1)}K` : v.toFixed(2), PAD.left - 6, yC(v) + 4);
  }

  ctx.textAlign = 'left'; ctx.fillStyle = '#0ecb81'; ctx.fillText('▬ Bids', PAD.left + 4, PAD.top - 8);
  ctx.fillStyle = '#f6465d'; ctx.fillText('▬ Asks', PAD.left + 56, PAD.top - 8);
}

function DepthCanvas({ bids, asks }: { bids: DepthPoint[]; asks: DepthPoint[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const draw = () => { if (ref.current) drawDepth(ref.current, bids, asks); };
  useEffect(draw, [bids, asks]);
  useEffect(() => { window.addEventListener('resize', draw); return () => window.removeEventListener('resize', draw); }, [bids, asks]); // eslint-disable-line
  return <canvas ref={ref} className={styles.depthCanvas} />;
}

/* ── Price chart ── */

export function TradeChart({ oraclePrice, bids, asks, asset }: TradeChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<IChartApi | null>(null);
  const candleRef    = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const oracleRef    = useRef<ISeriesApi<'Line'> | null>(null);
  const volRef       = useRef<ISeriesApi<'Histogram'> | null>(null);

  const [view, setView]           = useState<ChartView>('price');
  const [timeframe, setTimeframe] = useState<Timeframe>('1D');
  const [ohlcData, setOhlcData]   = useState<OHLCV[]>([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState('');

  const depthBids = useMemo(() => { let s = 0; return bids.map(([p, q]) => { s += Number(q) / 1e5; return { price: Number(p) * 1000, cum: s }; }); }, [bids]);
  const depthAsks = useMemo(() => { let s = 0; return asks.map(([p, q]) => { s += Number(q) / 1e5; return { price: Number(p) * 1000, cum: s }; }); }, [asks]);

  /* ── Fetch market OHLC data ── */
  useEffect(() => {
    if (view !== 'price') return;
    let cancelled = false;
    setLoading(true); setError('');
    fetchMarketData(asset, timeframe)
      .then(data => { if (!cancelled) { setOhlcData(data); setLoading(false); } })
      .catch(() => { if (!cancelled) { setError('Could not load market data'); setLoading(false); } });
    return () => { cancelled = true; };
  }, [asset, timeframe, view]);

  /* ── Create chart once ── */
  useEffect(() => {
    if (view !== 'price' || !containerRef.current) return;

    const el = containerRef.current;
    const w = el.clientWidth  || 600;
    const h = el.clientHeight || 380;

    const chart = createChart(el, {
      width: w,
      height: h,
      layout: {
        background: { type: ColorType.Solid, color: CHART_BG },
        textColor: '#848e9c',
        fontSize: 11,
      },
      grid: { vertLines: { color: '#1a1f26' }, horzLines: { color: '#1a1f26' } },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#474d57', labelBackgroundColor: '#1e2329' },
        horzLine: { color: '#474d57', labelBackgroundColor: '#1e2329' },
      },
      timeScale: { borderColor: '#2b2f36', timeVisible: true, secondsVisible: false, fixLeftEdge: true, fixRightEdge: true },
      rightPriceScale: { borderColor: '#2b2f36', minimumWidth: 68 },
      handleScroll: true,
      handleScale: true,
    });

    candleRef.current = chart.addSeries(CandlestickSeries, {
      upColor: '#0ecb81',   downColor: '#f6465d',
      borderUpColor: '#0ecb81', borderDownColor: '#f6465d',
      wickUpColor: '#0ecb81', wickDownColor: '#f6465d',
    });

    oracleRef.current = chart.addSeries(LineSeries, {
      color: PRIMARY, lineWidth: 1, lineStyle: LineStyle.Dashed,
      lastValueVisible: true, priceLineVisible: false, title: 'Mark',
    });

    volRef.current = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' }, priceScaleId: 'volume',
    });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    chartRef.current = chart;

    /* ResizeObserver keeps the chart in sync with its CSS container */
    const ro = new ResizeObserver(() => {
      if (!containerRef.current || !chartRef.current) return;
      const { clientWidth, clientHeight } = containerRef.current;
      if (clientWidth > 0 && clientHeight > 0) {
        chartRef.current.applyOptions({ width: clientWidth, height: clientHeight });
      }
    });
    ro.observe(el);

    /* Force a layout pass so the chart measures correctly after grid paint */
    requestAnimationFrame(() => {
      if (containerRef.current && chartRef.current) {
        const { clientWidth, clientHeight } = containerRef.current;
        if (clientWidth > 0) chartRef.current.applyOptions({ width: clientWidth, height: clientHeight || 380 });
      }
    });

    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; };
  }, [view]);

  /* ── Update candlestick data ── */
  useEffect(() => {
    if (!candleRef.current || !volRef.current || !oracleRef.current || !chartRef.current) return;
    if (!ohlcData.length) return;

    candleRef.current.setData(ohlcData);

    volRef.current.setData(ohlcData.map((d, i) => ({
      time: d.time, value: d.volume,
      color: i > 0 && d.close >= d.open ? 'rgba(14,203,129,0.65)' : 'rgba(246,70,93,0.65)',
    })));

    if (oraclePrice > 0) {
      oracleRef.current.setData([
        { time: ohlcData[0].time, value: oraclePrice },
        { time: ohlcData[ohlcData.length - 1].time, value: oraclePrice },
      ]);
    }

    chartRef.current.timeScale().fitContent();
  }, [ohlcData, oraclePrice]);

  return (
    <div className={styles.wrapper}>
      <div className={styles.toolbar}>
        <div className={styles.viewTabs}>
          <button className={view === 'price' ? styles.activeTab : ''} onClick={() => setView('price')}>Price</button>
          <button className={view === 'depth' ? styles.activeTab : ''} onClick={() => setView('depth')}>Depth</button>
        </div>

        {view === 'price' && (
          <>
            <div className={styles.assetInfo}>
              <span className={styles.assetName}>{asset}/USD</span>
              {ohlcData.length > 0 && (
                <span className={
                  ohlcData[ohlcData.length - 1].close >= ohlcData[ohlcData.length - 1].open
                    ? styles.priceUp : styles.priceDown
                }>
                  ${ohlcData[ohlcData.length - 1].close.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              )}
              {oraclePrice > 0 && <span className={styles.oracleTag}>Oracle ${oraclePrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>}
            </div>
            <div className={styles.timeframeTabs}>
              {TIMEFRAMES.map(t => (
                <button key={t} className={timeframe === t ? styles.activeTab : ''} onClick={() => setTimeframe(t)}>{t}</button>
              ))}
            </div>
          </>
        )}
      </div>

      <div className={styles.chartWrap}>
        {view === 'price' ? (
          <>
            <div ref={containerRef} className={styles.chartContainer} style={{ visibility: ohlcData.length ? 'visible' : 'hidden' }} />
            {(loading || !ohlcData.length) && (
              <div className={styles.emptyOverlay}>
                {loading ? (
                  <>
                    <div className={styles.emptyTitle}>Loading market data…</div>
                    <div className={styles.emptyHint}>{asset}/USDT · Binance</div>
                  </>
                ) : error ? (
                  <>
                    <div className={styles.emptyTitle}>Market data unavailable</div>
                    <div className={styles.emptyHint}>{error}</div>
                  </>
                ) : oraclePrice > 0 ? (
                  <>
                    <div className={styles.emptyOraclePrice}>
                      ${oraclePrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                    <div className={styles.emptyAsset}>{asset} / USD · Oracle Price</div>
                  </>
                ) : (
                  <div className={styles.emptyTitle}>Loading…</div>
                )}
              </div>
            )}
          </>
        ) : (
          <DepthCanvas bids={depthBids} asks={depthAsks} />
        )}
      </div>
    </div>
  );
}
