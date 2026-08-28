import { User, BarChart2, TrendingUp } from 'lucide-react';

// Network + program are environment-driven so the same build can target testnet,
// mainnet, or a local node. Defaults point at Vara mainnet (v1 launch).
// Set these in `.env` (see frontend/.env.example) or in your Vercel project settings.
export const NODE_ADDRESS =
  import.meta.env.VITE_NODE_ADDRESS ?? 'wss://rpc.vara.network';

// thebook v1 on Vara mainnet.
export const PROGRAM_ID = (import.meta.env.VITE_PROGRAM_ID ??
  '0x8ff92cabb35bdeec210f203f3afcb626e2db106a8362ffff4f5b7b344917fac4') as `0x${string}`;

// True until a real program ID is wired in - used to surface a setup banner instead
// of silently talking to the zero address.
export const PROGRAM_ID_CONFIGURED =
  PROGRAM_ID !== '0x0000000000000000000000000000000000000000000000000000000000000000';

export const NETWORK_NAME = import.meta.env.VITE_NETWORK_NAME ?? 'Vara Mainnet';

// NOTE: the `TOKENS` / `TokenMeta` registry that used to live here described the
// four wrapped tokens of the legacy virtual-balance model, keyed by a `TokenKind`
// enum the contract no longer has. v1 reads its markets from `Spot/GetPairs` and
// each token's decimals from the pair itself, so nothing needs a static list.
// The `VITE_TOKEN_*` env vars are likewise unused.

// Registry of the curated Vara-mainnet bridged tokens (addresses lowercased). The
// on-chain VftMetadata/Symbol query is occasionally slow or fails; falling back to
// this keeps the UI showing real symbols (not raw addresses) and lets the price
// chart/oracle resolve the right feed by token address, independent of symbols.
// `priceKey` maps to the market-data feed (null = a stable quote, ~$1).
export interface KnownToken { symbol: string; priceKey: 'BTC' | 'ETH' | 'VARA' | null; }
export const KNOWN_TOKENS: Record<string, KnownToken> = {
  '0x29c42c668012b1ce20720e4615229215023281ef4676fdc77bf047d7fbcb9d17': { symbol: 'WVARA', priceKey: 'VARA' },
  '0xde45bdbb0345919a11561d43a5082e0b25061d4a2c6eb80009c1cfbccb80d0de': { symbol: 'WETH', priceKey: 'ETH' },
  '0x4255ff4a87a4c13dc39f74ace8c4948bbef2f75fb639d66639a1cfcc99e6243e': { symbol: 'WUSDT', priceKey: null },
  '0xd1de816d7dce6439504552686ab333e5b7302b1549763656b30af1f8a5871b6a': { symbol: 'WUSDC', priceKey: null },
};
export function knownToken(addr: string): KnownToken | undefined {
  return addr ? KNOWN_TOKENS[addr.toLowerCase()] : undefined;
}

// Optional gasless backend that issues/points to a voucher sponsoring the user's
// claim + deposit gas. When unset, the UI falls back to the user paying gas.
export const GASLESS_BACKEND =
  (import.meta.env.VITE_GASLESS_BACKEND ?? '') as string;

export interface NavItem {
  id: string;
  label: string;
  icon: React.ElementType;
}

// v1 is spot-only: Futures/Swap/Pools (the virtual-balance surfaces) are parked
// until v2. Their view files remain in the repo but are not routed.
export const NAV_ITEMS: NavItem[] = [
  { id: 'trade',     label: 'Trade',     icon: BarChart2 },
  { id: 'perps',     label: 'Perps',     icon: TrendingUp },
  { id: 'portfolio', label: 'Portfolio', icon: User },
];

// The phone bottom bar mirrors the desktop tabs.
const MOBILE_NAV_IDS = ['trade', 'perps', 'portfolio'];
export const MOBILE_NAV_ITEMS: NavItem[] = MOBILE_NAV_IDS
  .map((id) => NAV_ITEMS.find((n) => n.id === id)!)
  .filter(Boolean);
