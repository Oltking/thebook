import { User, BarChart2 } from 'lucide-react';

// Network + program are environment-driven so the same build can target testnet,
// mainnet, or a local node. Defaults point at Vara testnet for the testnet launch.
// Set these in `.env` (see frontend/.env.example) or in your Vercel project settings.
export const NODE_ADDRESS =
  import.meta.env.VITE_NODE_ADDRESS ?? 'wss://testnet.vara.network';

export const PROGRAM_ID = (import.meta.env.VITE_PROGRAM_ID ??
  '0x0000000000000000000000000000000000000000000000000000000000000000') as `0x${string}`;

// True until a real program ID is wired in - used to surface a setup banner instead
// of silently talking to the zero address.
export const PROGRAM_ID_CONFIGURED =
  PROGRAM_ID !== '0x0000000000000000000000000000000000000000000000000000000000000000';

export const NETWORK_NAME = import.meta.env.VITE_NETWORK_NAME ?? 'Vara Testnet';

const ZERO_ADDR =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`;

// The four wrapped test tokens the DEX custodies. Each is a separate VFT program
// deployed from `token/`; users claim from its faucet then deposit into the DEX.
// Program IDs are environment-driven so the same build works across deployments.
export interface TokenMeta {
  kind: TokenKind;
  label: string;
  symbol: string;
  decimals: number;
  programId: `0x${string}`;
}

export const TOKENS: TokenMeta[] = [
  { kind: 'Usd', label: 'Tether USD', symbol: 'USDT', decimals: 6, programId: (import.meta.env.VITE_TOKEN_USD ?? ZERO_ADDR) as `0x${string}` },
  { kind: 'Btc', label: 'Bitcoin', symbol: 'wBTC', decimals: 6, programId: (import.meta.env.VITE_TOKEN_BTC ?? ZERO_ADDR) as `0x${string}` },
  { kind: 'Eth', label: 'Ethereum', symbol: 'wETH', decimals: 6, programId: (import.meta.env.VITE_TOKEN_ETH ?? ZERO_ADDR) as `0x${string}` },
  { kind: 'Vara', label: 'Vara', symbol: 'wVARA', decimals: 6, programId: (import.meta.env.VITE_TOKEN_VARA ?? ZERO_ADDR) as `0x${string}` },
];

export const TOKENS_CONFIGURED = TOKENS.every((t) => t.programId !== ZERO_ADDR);

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
  { id: 'portfolio', label: 'Portfolio', icon: User },
];

// The phone bottom bar mirrors the (currently two) desktop tabs. The Hive
// (agent world) is reached from the header switch, not the bottom bar.
const MOBILE_NAV_IDS = ['trade', 'portfolio'];
export const MOBILE_NAV_ITEMS: NavItem[] = MOBILE_NAV_IDS
  .map((id) => NAV_ITEMS.find((n) => n.id === id)!)
  .filter(Boolean);
