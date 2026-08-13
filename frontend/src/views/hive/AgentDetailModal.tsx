import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSails } from '../../hooks/useSails';
import { useMarketData } from '../../providers/MarketDataProvider';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { X } from 'lucide-react';
import styles from './AgentDetailModal.module.css';

const USD = 1e6;      // micro-dollars per dollar
const UNIT = 1e5;     // size units per whole asset
const ASSETS = ['BTC', 'ETH', 'VARA'] as const;
type AssetT = (typeof ASSETS)[number];

// On-chain ids come back as hex string or byte array; normalise to lowercase hex.
function hexOf(id: unknown): string {
  if (typeof id === 'string') return id.toLowerCase();
  if (Array.isArray(id)) return '0x' + id.map((b) => Number(b).toString(16).padStart(2, '0')).join('');
  return String(id).toLowerCase();
}
const usd0 = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const usd2 = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
// Sub-cent notionals (small VARA fills) would round to $0 at 2 decimals — keep them legible.
const usdSmart = (n: number) => (n !== 0 && Math.abs(n) < 0.01 ? `$${n.toFixed(5)}` : usd2(n));
const px = (p: number, a: string) => `$${p.toLocaleString(undefined, { maximumFractionDigits: a === 'VARA' ? 6 : 2 })}`;

interface Holding { asset: string; amount: number; value: number; }
interface Position { asset: string; long: boolean; size: number; entry: number; margin: number; lev: number; pnl: number; }
interface Order { oid: number; side: string; asset: string; price: number; qty: number; filled: number; status: string; }
interface Fill { id: number; asset: string; side: string; price: number; qty: number; }

interface Props {
  agent: { addr: string; name: string; strategy: string; me?: boolean };
  onClose: () => void;
}

export function AgentDetailModal({ agent, onClose }: Props) {
  const { program } = useSails();
  const { prices } = useMarketData();
  const trap = useFocusTrap<HTMLDivElement>(true, onClose);

  const [loading, setLoading] = useState(true);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [fills, setFills] = useState<Fill[]>([]);

  const spot = (a: AssetT) => {
    const f = prices[a];
    return f ? Number(f.price_usd_micro) / USD : 0;
  };

  useEffect(() => {
    let on = true;
    const addr = agent.addr;
    const run = async () => {
      if (!program) return;
      try {
        const [port, ords, pos, ...tradeSets]: any[] = await Promise.all([
          program.orderbook.getPortfolio().withAddress(addr).call().catch(() => null),
          program.orderbook.getMyOrders().withAddress(addr).call().catch(() => []),
          program.perps.getPositions(addr as `0x${string}`).call().catch(() => []),
          ...ASSETS.map((a) => program.orderbook.getTrades(a, 60).call().then((t: any) => ({ a, t })).catch(() => ({ a, t: [] }))),
        ]);
        if (!on) return;

        // Holdings (valued at live spot)
        const usdV = port ? Number(port[0]) / USD : 0;
        const amt = (i: number) => (port ? Number(port[i]) / UNIT : 0);
        setHoldings([
          { asset: 'USDT', amount: usdV, value: usdV },
          { asset: 'BTC', amount: amt(1), value: amt(1) * spot('BTC') },
          { asset: 'ETH', amount: amt(2), value: amt(2) * spot('ETH') },
          { asset: 'VARA', amount: amt(3), value: amt(3) * spot('VARA') },
        ]);

        setOrders((Array.isArray(ords) ? ords : []).map((o: any) => ({
          oid: Number(o[0]), side: String(o[1]), asset: String(o[2]),
          price: Number(o[3]) / USD, qty: Number(o[4]) / UNIT, filled: Number(o[5]) / UNIT,
          status: String(o[6]),
        })));

        setPositions((Array.isArray(pos) ? pos : []).map((p: any) => ({
          asset: String(p[0]), long: Boolean(p[1]), size: Number(p[2]) / UNIT,
          entry: Number(p[3]) / USD, margin: Number(p[4]) / USD, lev: Number(p[5]),
          pnl: Number(p[6]) / USD,
        })));

        // Fills involving this agent, across all assets, newest first.
        const me = hexOf(addr);
        const fs: Fill[] = [];
        for (const { a, t } of tradeSets as { a: AssetT; t: any[] }[]) {
          for (const row of Array.isArray(t) ? t : []) {
            const buyer = hexOf(row[3]); const seller = hexOf(row[4]);
            if (buyer !== me && seller !== me) continue;
            fs.push({ id: Number(row[0]), asset: a, side: buyer === me ? 'Buy' : 'Sell', price: Number(row[1]) / USD, qty: Number(row[2]) / UNIT });
          }
        }
        fs.sort((x, y) => y.id - x.id);
        setFills(fs.slice(0, 25));
      } finally {
        if (on) setLoading(false);
      }
    };
    run();
    const iv = setInterval(() => { if (!document.hidden) run(); }, 8000);
    return () => { on = false; clearInterval(iv); };
  }, [program, agent.addr]);

  const netWorth = useMemo(() => holdings.reduce((s, h) => s + h.value, 0), [holdings]);
  const pnl = netWorth - 1000;               // everyone starts with $1,000 USDT
  const upnl = useMemo(() => positions.reduce((s, p) => s + p.pnl, 0), [positions]);
  const pnlCls = pnl >= 0 ? styles.up : styles.down;

  // Portal to <body> so `position: fixed` is relative to the viewport, not a
  // transformed ancestor (the hive world uses transforms, which would trap it).
  return createPortal(
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label={`${agent.name} activity`} onClick={onClose}>
      <div ref={trap} tabIndex={-1} className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <button className={styles.close} onClick={onClose} aria-label="Close"><X size={18} /></button>

        <div className={styles.head}>
          <div>
            <div className={styles.name}>{agent.name}{agent.me ? ' · you' : ''}</div>
            <div className={styles.strat}>{agent.strategy.replace(/([A-Z])/g, ' $1').trim()}</div>
            <div className={styles.addr}>{agent.addr.slice(0, 8)}…{agent.addr.slice(-6)}</div>
          </div>
          <div className={styles.headStats}>
            <div><span className={styles.hv}>{usd0(netWorth)}</span><span className={styles.hk}>Net worth</span></div>
            <div><span className={`${styles.hv} ${pnlCls}`}>{pnl >= 0 ? '+' : ''}{usd2(pnl)}</span><span className={styles.hk}>PnL vs $1,000</span></div>
          </div>
        </div>

        {loading ? (
          <div className={styles.loading}>Reading on-chain activity…</div>
        ) : (
          <div className={styles.body}>
            {/* Holdings */}
            <section className={styles.sec}>
              <h4 className={styles.secTitle}>Holdings</h4>
              <div className={styles.rows}>
                {holdings.map((h) => (
                  <div className={styles.row} key={h.asset}>
                    <span className={styles.cAsset}>{h.asset}</span>
                    <span className={styles.cAmt}>{h.amount.toLocaleString(undefined, { maximumFractionDigits: h.asset === 'USDT' ? 2 : 5 })}</span>
                    <span className={styles.cVal}>{usd2(h.value)}</span>
                  </div>
                ))}
              </div>
            </section>

            {/* Open perp positions */}
            <section className={styles.sec}>
              <h4 className={styles.secTitle}>Open positions {positions.length > 0 && <span className={styles.pill}>{positions.length}</span>}
                {positions.length > 0 && <span className={`${styles.upnl} ${upnl >= 0 ? styles.up : styles.down}`}>uPnL {upnl >= 0 ? '+' : ''}{usd2(upnl)}</span>}
              </h4>
              {positions.length === 0 ? <div className={styles.empty}>No open perpetual positions.</div> : (
                <div className={styles.rows}>
                  {positions.map((p, i) => (
                    <div className={styles.rowWide} key={i}>
                      <span className={`${styles.dir} ${p.long ? styles.up : styles.down}`}>{p.long ? 'LONG' : 'SHORT'} {p.lev}×</span>
                      <span className={styles.cAsset}>{p.asset}</span>
                      <span className={styles.cSub}>{p.size.toLocaleString(undefined, { maximumFractionDigits: 5 })} @ {px(p.entry, p.asset)}</span>
                      <span className={styles.cSub}>margin {usd2(p.margin)}</span>
                      <span className={`${styles.cVal} ${p.pnl >= 0 ? styles.up : styles.down}`}>{p.pnl >= 0 ? '+' : ''}{usd2(p.pnl)}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Open orders */}
            <section className={styles.sec}>
              <h4 className={styles.secTitle}>Open orders {orders.length > 0 && <span className={styles.pill}>{orders.length}</span>}</h4>
              {orders.length === 0 ? <div className={styles.empty}>No resting orders.</div> : (
                <div className={styles.rows}>
                  {orders.map((o) => (
                    <div className={styles.rowWide} key={o.oid}>
                      <span className={`${styles.dir} ${o.side === 'Buy' ? styles.up : styles.down}`}>{o.side.toUpperCase()}</span>
                      <span className={styles.cAsset}>{o.asset}</span>
                      <span className={styles.cSub}>{o.qty.toLocaleString(undefined, { maximumFractionDigits: 5 })} @ {px(o.price, o.asset)}</span>
                      <span className={styles.cSub}>{o.filled > 0 ? `${((o.filled / o.qty) * 100).toFixed(0)}% filled` : 'resting'}</span>
                      <span className={styles.cStatus}>{o.status}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Recent fills (executed trades) */}
            <section className={styles.sec}>
              <h4 className={styles.secTitle}>Recent fills {fills.length > 0 && <span className={styles.pill}>{fills.length}</span>}</h4>
              {fills.length === 0 ? <div className={styles.empty}>No trades yet.</div> : (
                <div className={styles.rows}>
                  {fills.map((f) => (
                    <div className={styles.rowWide} key={`${f.asset}-${f.id}`}>
                      <span className={`${styles.dir} ${f.side === 'Buy' ? styles.up : styles.down}`}>{f.side.toUpperCase()}</span>
                      <span className={styles.cAsset}>{f.asset}</span>
                      <span className={styles.cSub}>{f.qty.toLocaleString(undefined, { maximumFractionDigits: 5 })}</span>
                      <span className={styles.cSub}>@ {px(f.price, f.asset)}</span>
                      <span className={styles.cVal}>{usdSmart(f.qty * f.price)}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
