import { lazy, Suspense, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Layout } from './components/layout/Layout';
import { SkeletonCard } from './components/ui/Skeleton';
import { OnboardingWizard } from './components/ui/OnboardingWizard';
import { useOnboarding } from './hooks/useOnboarding';

const TradeView = lazy(() => import('./views/TradeView').then(m => ({ default: m.TradeView })));
const SpotTradeView = lazy(() => import('./views/SpotTradeView').then(m => ({ default: m.SpotTradeView })));
const SwapView = lazy(() => import('./views/SwapView').then(m => ({ default: m.SwapView })));
const PoolsView = lazy(() => import('./views/PoolsView').then(m => ({ default: m.PoolsView })));
const SpotPortfolioView = lazy(() => import('./views/SpotPortfolioView').then(m => ({ default: m.SpotPortfolioView })));
const HiveView = lazy(() => import('./views/hive/HiveView').then(m => ({ default: m.HiveView })));
const LandingView = lazy(() => import('./views/LandingView').then(m => ({ default: m.LandingView })));

function PageLoader() {
  return (
    <div style={{ padding: 24 }}>
      <SkeletonCard lines={6} />
    </div>
  );
}

const TABS = ['trade', 'futures', 'swap', 'pools', 'portfolio'];

// The app has its own address so a refresh keeps you inside it. The public
// landing is the root ("/"); the app lives under "/app". An "app." subdomain
// (app.thesite) counts as being in the app too, so you can point DNS at the
// same deploy and land straight in. The Hive is the first side of the app, so a
// bare "/app" lands there; "/app/<tab>" opens the trading side on that tab.
function readLocation(): { entered: boolean; mode: 'trade' | 'hive'; tab: string } {
  const host = window.location.hostname;
  const onAppHost = host === 'app' || host.startsWith('app.');
  const path = window.location.pathname.replace(/\/+$/, '');
  const seg = path.split('/').filter(Boolean); // e.g. ['app','futures']
  const inApp = onAppHost || seg[0] === 'app';
  if (!inApp) return { entered: false, mode: 'trade', tab: 'trade' };
  // On an app host the app segments start at 0; on a path they start after 'app'.
  const rest = onAppHost ? seg : seg.slice(1);
  // Bare "/app" (or the app host root) lands on the Hive, the first side.
  if (!rest[0] || rest[0] === 'hive') return { entered: true, mode: 'hive', tab: 'trade' };
  const tab = TABS.includes(rest[0]) ? rest[0] : 'trade';
  return { entered: true, mode: 'trade', tab };
}

// Build the URL that reflects the current world, respecting an app.* host.
function urlFor(entered: boolean, mode: 'trade' | 'hive', tab: string): string {
  const onAppHost = window.location.hostname.startsWith('app.') || window.location.hostname === 'app';
  const base = onAppHost ? '' : '/app';
  if (!entered) return '/';
  if (mode === 'hive') return `${base}/hive`;
  return `${base}/${tab}`;
}

function App() {
  const initial = readLocation();
  const [activeTab, setActiveTab] = useState(initial.tab);
  // Two worlds: the trading app and The Hive (agent ecosystem). The "Agent" nav
  // item crosses into the Hive; the Hive's own switch crosses back.
  const [mode, setMode] = useState<'trade' | 'hive'>(initial.mode);
  // Public landing is the front door; entering the app moves the URL to /app so
  // a refresh stays put. The Hive is the first side, so entering lands there.
  const [entered, setEntered] = useState(initial.entered);
  const enterApp = (toHive = true) => {
    setMode(toHive ? 'hive' : 'trade');
    setEntered(true);
  };
  const { showWizard, completeOnboarding, dismissWizard } = useOnboarding();

  const navigate = (tab: string) => {
    if (tab === 'agent') { setMode('hive'); return; }
    setActiveTab(tab);
  };

  // Keep the URL in sync with the world so refresh / back / forward work.
  useEffect(() => {
    const target = urlFor(entered, mode, activeTab);
    if (window.location.pathname !== target) {
      window.history.pushState(null, '', target);
    }
  }, [entered, mode, activeTab]);

  // Respond to browser back/forward.
  useEffect(() => {
    const onPop = () => {
      const loc = readLocation();
      setEntered(loc.entered);
      setMode(loc.mode);
      setActiveTab(loc.tab);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const renderContent = () => {
    switch (activeTab) {
      case 'trade':
        return <SpotTradeView />;
      case 'futures':
        return <TradeView mode="futures" />;
      case 'swap':
        return <SwapView />;
      case 'pools':
        return <PoolsView />;
      case 'portfolio':
        return <SpotPortfolioView />;
      default:
        return <TradeView mode="spot" />;
    }
  };

  // Which world is on screen, for the crossfade between landing / trade / hive.
  // NOTE: animate OPACITY ONLY. transform/filter would create a containing block
  // and break the fixed header, sidebar and Hive positioning.
  const world = !entered ? 'landing' : mode === 'hive' ? 'hive' : 'trade';
  const fade = {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: { duration: 0.35, ease: [0.22, 1, 0.36, 1] as const },
    // #root is a flex row; make each world span the full width.
    style: { flex: 1, minWidth: 0, width: '100%' },
  };

  return (
    <>
      <AnimatePresence mode="wait">
        {world === 'landing' && (
          <motion.div key="landing" {...fade}>
            <Suspense fallback={<PageLoader />}>
              <LandingView onLaunch={() => enterApp(false)} onEnterHive={() => enterApp(true)} />
            </Suspense>
          </motion.div>
        )}
        {world === 'hive' && (
          <motion.div key="hive" {...fade}>
            <Suspense fallback={<PageLoader />}>
              <HiveView
                onExitHive={() => setMode('trade')}
                onDeploy={() => window.dispatchEvent(new Event('thebookdex:open-wizard'))}
              />
            </Suspense>
          </motion.div>
        )}
        {world === 'trade' && (
          <motion.div key="trade" {...fade}>
            <Layout activeTab={activeTab} setActiveTab={navigate} onEnterHive={() => setMode('hive')}>
              <Suspense fallback={<PageLoader />}>
                {renderContent()}
              </Suspense>
            </Layout>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Onboarding only belongs inside the app, never over the public landing. */}
      {entered && showWizard && (
        <OnboardingWizard
          onComplete={completeOnboarding}
          onDismiss={dismissWizard}
          onNavigateToTab={(t) => { if (t === 'agent') { setMode('hive'); } else { setMode('trade'); setActiveTab(t); } }}
        />
      )}
    </>
  );
}

export default App;
