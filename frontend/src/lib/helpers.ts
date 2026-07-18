export function toBigInt(v: any): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string') return BigInt(v);
  if (v?.toString) return BigInt(v.toString());
  return 0n;
}

export function toPair(v: any): [bigint, bigint] {
  if (Array.isArray(v)) return [toBigInt(v[0]), toBigInt(v[1])];
  if (v && typeof v === 'object') return [toBigInt((v as any)[0] || (v as any).price), toBigInt((v as any)[1] || (v as any).qty)];
  return [0n, 0n];
}

/* Stable timestamp per trade ID - persisted to sessionStorage so page reloads don't reset them */
const TS_KEY = 'thebookdex:trade-ts';

function loadStoredTs(): Map<string, string> {
  try {
    const raw = sessionStorage.getItem(TS_KEY);
    if (raw) return new Map(Object.entries(JSON.parse(raw)));
  } catch {}
  return new Map();
}

function saveTs(map: Map<string, string>) {
  try {
    if (map.size > 500) {
      /* Keep only the 400 most recent entries */
      const entries = [...map.entries()].slice(-400);
      sessionStorage.setItem(TS_KEY, JSON.stringify(Object.fromEntries(entries)));
    } else {
      sessionStorage.setItem(TS_KEY, JSON.stringify(Object.fromEntries(map)));
    }
  } catch {}
}

const tradeSeenAt: Map<string, string> = loadStoredTs();

export function toTradesArray(result: any): any[] {
  if (!result || !Array.isArray(result)) return [];
  let changed = false;
  const out = result.map((t: any) => {
    const id = t?.[0]?.toString() || '0';
    if (!tradeSeenAt.has(id)) {
      tradeSeenAt.set(id, new Date().toLocaleTimeString());
      changed = true;
    }
    return {
      id,
      price:  toBigInt(t?.[1]),
      qty:    toBigInt(t?.[2]),
      buyer:  t?.[3]?.toString?.() || '',
      seller: t?.[4]?.toString?.() || '',
      time:   tradeSeenAt.get(id)!,
    };
  });
  if (changed) saveTs(tradeSeenAt);
  return out;
}
