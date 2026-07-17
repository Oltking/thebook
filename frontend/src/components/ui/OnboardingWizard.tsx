import { useState, useCallback } from 'react';
import { useAccount } from '@gear-js/react-hooks';
import { web3Enable, web3Accounts } from '@polkadot/extension-dapp';
import { decodeAddress } from '@polkadot/util-crypto';
import { u8aToHex } from '@polkadot/util';
import { usePortfolio } from '../../hooks/usePortfolio';
import { useVault } from '../../hooks/useVault';
import { useToast } from './Toast';
import { parseContractError } from '../../lib/errors';
import { TOKENS, TOKENS_CONFIGURED } from '../../consts';
import { Wallet, Rocket, ArrowRight, Check, X, Loader2, Crosshair, Waypoints, TrendingUp, Bot, Coins } from 'lucide-react';
import styles from './OnboardingWizard.module.css';

interface OnboardingWizardProps {
  onComplete: () => void;
  onDismiss: () => void;
  onNavigateToTab: (tab: string) => void;
}

type Step = 'welcome' | 'connect' | 'create' | 'fund' | 'done';

// Starting balances handed out at the faucet, one deposit per wrapped token. These
// match each token program's per-account faucet amount (see token deploy).
const FUND_AMOUNTS: Record<TokenKind, bigint> = {
  Usd: 100_000n,
  Btc: 100_000n,
  Eth: 1_000_000n,
  Vara: 1_000_000_000n,
};

const STRATEGIES: { id: AgentStrategy; label: string; desc: string; icon: typeof Crosshair }[] = [
  { id: 'ArbitrageHunter', label: 'Arbitrage Hunter', desc: 'Hunts price gaps between the orderbook, AMM pools, and spot.', icon: Crosshair },
  { id: 'MarketMaker',     label: 'Market Maker',     desc: 'Quotes both sides of the book and earns the spread.',        icon: Waypoints },
  { id: 'Momentum',        label: 'Momentum',         desc: 'Rides assets that are trending and moving fast.',            icon: TrendingUp },
];

export function OnboardingWizard({ onComplete, onDismiss, onNavigateToTab }: OnboardingWizardProps) {
  const { account, login } = useAccount();
  const { portfolio, join, loading, refresh } = usePortfolio();
  const { claimAndDeposit, step: vaultStep, busy: funding } = useVault();
  const { success, error } = useToast();
  const [step, setStep] = useState<Step>('welcome');
  const [joining, setJoining] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [agentName, setAgentName] = useState('');
  const [strategy, setStrategy] = useState<AgentStrategy>('ArbitrageHunter');

  const funded =
    !!portfolio &&
    (portfolio.usd > 0n || portfolio.btc > 0n || portfolio.eth > 0n || portfolio.vara > 0n);

  const currentStep = (): Step => {
    if (!account) return step === 'welcome' ? 'welcome' : 'connect';
    if (!portfolio) return 'create';
    if (!funded && TOKENS_CONFIGURED) return 'fund';
    return 'done';
  };

  const effectiveStep = currentStep();

  const handleConnectWallet = useCallback(async () => {
    setConnecting(true);
    try {
      const exts = await web3Enable('thebookdex');
      if (exts.length === 0) {
        error('No wallet extension detected. Install Polkadot.js or SubWallet.');
        setConnecting(false);
        return;
      }
      const allAccounts = await web3Accounts();
      if (allAccounts.length === 0) {
        error('No accounts found in your wallet extension.');
        setConnecting(false);
        return;
      }
      const acc = allAccounts[0];
      login({
        ...acc,
        decodedAddress: u8aToHex(decodeAddress(acc.address)),
        signer: exts[0].signer,
      });
    } catch (e: any) {
      error(e?.message || 'Failed to connect wallet.');
    }
    setConnecting(false);
  }, [login, error]);

  const handleCreate = async () => {
    const name = agentName.trim();
    if (!name) { error('Give your agent a name.'); return; }
    setJoining(true);
    const err = await join(name, strategy);
    setJoining(false);
    if (err) {
      error(parseContractError(err));
    } else {
      success(`Agent "${name}" deployed. It's hunting the market for you.`);
    }
  };

  const handleFund = async () => {
    for (const t of TOKENS) {
      const err = await claimAndDeposit(t.kind, FUND_AMOUNTS[t.kind]);
      if (err) {
        error(parseContractError(err));
        return;
      }
    }
    await refresh();
    success('Starting balances claimed and deposited. You are ready to trade.');
  };

  const fundLabel = (): string => {
    switch (vaultStep) {
      case 'claiming': return 'Claiming test tokens...';
      case 'approving': return 'Approving the DEX...';
      case 'depositing': return 'Depositing to vault...';
      default: return 'Claim starting balances';
    }
  };

  const handleFinish = () => {
    onComplete();
    onNavigateToTab('agent');
  };

  const steps = [
    { key: 'welcome', label: 'Welcome', done: effectiveStep !== 'welcome' },
    { key: 'connect', label: 'Connect Wallet', done: !!account },
    { key: 'create', label: 'Create Agent', done: !!portfolio },
    { key: 'fund', label: 'Fund', done: funded },
    { key: 'done', label: 'Deploy', done: false },
  ];

  return (
    <div className={styles.overlay}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label="Create your trading agent">
        <button className={styles.closeBtn} onClick={onDismiss} aria-label="Skip onboarding">
          <X size={20} />
        </button>

        <div className={styles.stepsBar} role="progressbar" aria-valuenow={steps.filter(s => s.done).length} aria-valuemin={0} aria-valuemax={steps.length} aria-label="Onboarding progress">
          {steps.map((s, i) => (
            <div key={s.key} className={`${styles.stepDot} ${s.done ? styles.done : ''} ${s.key === effectiveStep ? styles.current : ''}`}>
              <div className={styles.dot}>{s.done ? <Check size={12} /> : i + 1}</div>
              <span className={styles.dotLabel}>{s.label}</span>
            </div>
          ))}
        </div>

        <div className={styles.content}>
          {effectiveStep === 'welcome' && (
            <>
              <div className={styles.iconWrap}>
                <Rocket size={48} className={styles.rocket} />
              </div>
              <h2 className={styles.title}>You don't trade here. You deploy an agent.</h2>
              <p className={styles.desc}>
                thebookdex is an on-chain agent arena on Vara. Create your own trading
                agent — it scans the orderbook, AMM pools, and live prices for market
                opportunities and surfaces them for you to act on.
              </p>
              <button className={styles.primaryBtn} onClick={() => setStep('connect')}>
                Get Started
                <ArrowRight size={18} />
              </button>
            </>
          )}

          {effectiveStep === 'connect' && (
            <>
              <div className={styles.iconWrap}>
                <Wallet size={48} className={styles.iconAccent} />
              </div>
              <h2 className={styles.title}>Connect Your Wallet</h2>
              <p className={styles.desc}>
                You'll need a Polkadot.js or SubWallet extension on Vara testnet. Your
                wallet is your agent's identity on-chain.
              </p>
              <button className={styles.primaryBtn} onClick={handleConnectWallet} disabled={connecting}>
                {connecting ? (
                  <><Loader2 size={18} className={styles.spin} /> Connecting...</>
                ) : (
                  <><Wallet size={18} /> Connect Wallet</>
                )}
              </button>
              <button className={styles.skipBtn} onClick={onDismiss}>
                Skip for now
              </button>
            </>
          )}

          {effectiveStep === 'create' && (
            <>
              <div className={styles.iconWrap}>
                <Bot size={48} className={styles.iconAccent} />
              </div>
              <h2 className={styles.title}>Create Your Agent</h2>
              <p className={styles.desc}>
                Name your agent and pick its trading style. This is a one-time on-chain
                registration of your identity — you'll claim starting balances next.
              </p>

              <input
                className={styles.skipBtn}
                style={{ width: '100%', textAlign: 'center', fontSize: 16, padding: '12px 14px', border: '1px solid var(--border-color)', borderRadius: 10, background: 'var(--bg-elevated)', color: 'inherit', marginBottom: 14 }}
                placeholder="Agent name (e.g. AlphaSeeker)"
                value={agentName}
                maxLength={24}
                onChange={e => setAgentName(e.target.value)}
              />

              <div style={{ display: 'grid', gap: 8, width: '100%', marginBottom: 16 }}>
                {STRATEGIES.map(s => {
                  const Icon = s.icon;
                  const active = strategy === s.id;
                  return (
                    <button
                      key={s.id}
                      onClick={() => setStrategy(s.id)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left',
                        padding: '12px 14px', borderRadius: 10, cursor: 'pointer',
                        border: `1px solid ${active ? 'var(--accent)' : 'var(--border-color)'}`,
                        background: active ? 'var(--accent-soft)' : 'transparent',
                        color: 'inherit',
                      }}
                    >
                      <Icon size={22} style={{ flexShrink: 0, color: active ? 'var(--accent)' : 'inherit' }} />
                      <span style={{ display: 'flex', flexDirection: 'column' }}>
                        <strong style={{ fontSize: 14 }}>{s.label}</strong>
                        <span style={{ fontSize: 12, opacity: 0.7 }}>{s.desc}</span>
                      </span>
                    </button>
                  );
                })}
              </div>

              <button
                className={styles.primaryBtn}
                onClick={handleCreate}
                disabled={joining || loading || !agentName.trim()}
              >
                {joining || loading ? 'Deploying agent...' : 'Deploy Agent'}
                {!joining && !loading && <ArrowRight size={18} />}
              </button>
              <button className={styles.skipBtn} onClick={onDismiss}>
                Skip for now
              </button>
            </>
          )}

          {effectiveStep === 'fund' && (
            <>
              <div className={styles.iconWrap}>
                <Coins size={48} className={styles.iconAccent} />
              </div>
              <h2 className={styles.title}>Claim Your Starting Balances</h2>
              <p className={styles.desc}>
                Claim wrapped test tokens ({TOKENS.map(t => t.symbol).join(', ')}) from the
                faucet and deposit them into the DEX vault. These are real, transferable
                testnet tokens — you can withdraw them anytime from your Portfolio.
              </p>
              <button
                className={styles.primaryBtn}
                onClick={handleFund}
                disabled={funding}
              >
                {funding ? (
                  <><Loader2 size={18} className={styles.spin} /> {fundLabel()}</>
                ) : (
                  <><Coins size={18} /> {fundLabel()}</>
                )}
              </button>
              <button className={styles.skipBtn} onClick={onDismiss}>
                I'll fund later
              </button>
            </>
          )}

          {effectiveStep === 'done' && (
            <>
              <div className={styles.iconWrap}>
                <div className={styles.checkCircle}>
                  <Check size={32} />
                </div>
              </div>
              <h2 className={styles.title}>Your Agent Is Live!</h2>
              <p className={styles.desc}>
                It's scanning the market for opportunities. Open the Agent dashboard to
                see signals, or trade manually anytime.
              </p>
              <button className={styles.primaryBtn} onClick={handleFinish}>
                Open Agent Dashboard
                <ArrowRight size={18} />
              </button>
              <button className={styles.skipBtn} onClick={onDismiss}>
                Explore later
              </button>
            </>
          )}
        </div>

        <p className={styles.footer}>
          {effectiveStep === 'done' ? '' : 'You can close this and come back anytime.'}
        </p>
      </div>
    </div>
  );
}
