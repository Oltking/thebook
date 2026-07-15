import { TrendingUp, ArrowLeftRight, Droplets, User, BarChart2, Trophy, Bot } from 'lucide-react';

// Network + program are environment-driven so the same build can target testnet,
// mainnet, or a local node. Defaults point at Vara testnet for the testnet launch.
// Set these in `.env` (see frontend/.env.example) or in your Vercel project settings.
export const NODE_ADDRESS =
  import.meta.env.VITE_NODE_ADDRESS ?? 'wss://testnet.vara.network';

export const PROGRAM_ID = (import.meta.env.VITE_PROGRAM_ID ??
  '0x0000000000000000000000000000000000000000000000000000000000000000') as `0x${string}`;

// True until a real program ID is wired in — used to surface a setup banner instead
// of silently talking to the zero address.
export const PROGRAM_ID_CONFIGURED =
  PROGRAM_ID !== '0x0000000000000000000000000000000000000000000000000000000000000000';

export const NETWORK_NAME = import.meta.env.VITE_NETWORK_NAME ?? 'Vara Testnet';

export interface NavItem {
  id: string;
  label: string;
  icon: React.ElementType;
}

export const NAV_ITEMS: NavItem[] = [
  { id: 'agent',     label: 'Agent',     icon: Bot },
  { id: 'trade',     label: 'Trade',     icon: BarChart2 },
  { id: 'futures',   label: 'Futures',   icon: TrendingUp },
  { id: 'swap',      label: 'Swap',      icon: ArrowLeftRight },
  { id: 'pools',     label: 'Pools',     icon: Droplets },
  { id: 'portfolio', label: 'Portfolio', icon: User },
  { id: 'leaderboard', label: 'Leaders', icon: Trophy },
];
