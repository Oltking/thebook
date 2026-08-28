import { lazy, Suspense, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Layout } from './components/layout/Layout';
import { SkeletonCard } from './components/ui/Skeleton';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { MaintenanceNotice } from './components/ui/MaintenanceNotice';

const SpotTradeView = lazy(() => import('./views/SpotTradeView').then(m => ({ default: m.SpotTradeView })));
const PerpsTradeView = lazy(() => import('./views/PerpsTradeView').then(m => ({ default: m.PerpsTradeView })));
const SpotPortfolioView = lazy(() => import('./views/SpotPortfolioView').then(m => ({ default: m.SpotPortfolioView })));
const LandingView = lazy(() => import('./views/LandingView').then(m => ({ default: m.LandingView })));

function PageLoader() {
  return (
    <div style={{ padding: 24 }}>
      <SkeletonCard lines={6} />
    </div>
  );
}

const TABS = ['trade', 'perps', 'portfolio'];

// The app has its own address so a refresh keeps you inside it. The public
// landing is the root ("/"); the app lives under "/app". An "app." subdomain
// (app.thesite) counts as being in the app too, so you can point DNS at the
// same deploy and land straight in. "/app/<tab>" opens the app on that tab.
function readLocation(): { entered: boolean; tab: string } {
  const host = window.location.hostname;
  const onAppHost = host === 'app' || host.startsWith('app.');
  const path = window.location.pathname.replace(/\/+$/, '');
  const seg = path.split('/').filter(Boolean); // e.g. ['app','futures']
  const inApp = onAppHost || seg[0] === 'app';
  if (!inApp) return { entered: false, tab: 'trade' };
  // On an app host the app segments start at 0; on a path they start after 'app'.
  const rest = onAppHost ? seg : seg.slice(1);
  // The Hive (the agent world) was removed with the legacy virtual-balance
  // services it ran on — see audit C-02. "/hive" now lands on the trade app.
  if (!rest[0]) return { entered: true, tab: 'trade' };
  const tab = TABS.includes(rest[0]) ? rest[0] : 'trade';
  return { entered: true, tab };
}

// Build the URL that reflects the current view, respecting an app.* host.
function urlFor(entered: boolean, tab: string): string {
  const onAppHost = window.location.hostname.startsWith('app.') || window.location.hostname === 'app';
  const base = onAppHost ? '' : '/app';
  if (!entered) return '/';
  return `${base}/${tab}`;
}

/** Operational kill switch: set VITE_MAINTENANCE to take the interface offline
 *  without tearing down the deployment (see docs/incident-runbook.md). */
const MAINTENANCE = String(import.meta.env.VITE_MAINTENANCE ?? '').toLowerCase();
const IN_MAINTENANCE = MAINTENANCE === '1' || MAINTENANCE === 'true';

function App() {
  const initial = readLocation();
  const [activeTab, setActiveTab] = useState(initial.tab);
  // Public landing is the front door; entering the app moves the URL to /app so
  // a refresh stays put.
  const [entered, setEntered] = useState(initial.entered);
  const enterApp = () => setEntered(true);

  const navigate = (tab: string) => setActiveTab(tab);

  // Keep the URL in sync with the world so refresh / back / forward work.
  useEffect(() => {
    const target = urlFor(entered, activeTab);
    if (window.location.pathname !== target) {
      window.history.pushState(null, '', target);
    }
  }, [entered, activeTab]);

  // Respond to browser back/forward.
  useEffect(() => {
    const onPop = () => {
      const loc = readLocation();
      setEntered(loc.entered);
      setActiveTab(loc.tab);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const renderContent = () => {
    switch (activeTab) {
      case 'trade':
        return <SpotTradeView />;
      case 'perps':
        return <PerpsTradeView />;
      case 'portfolio':
        return <SpotPortfolioView />;
      default:
        return <SpotTradeView />;
    }
  };

  // Which world is on screen, for the crossfade between landing and the app.
  // NOTE: animate OPACITY ONLY. transform/filter would create a containing block
  // and break the fixed header and sidebar positioning.
  const world = entered ? 'trade' : 'landing';
  const fade = {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: { duration: 0.35, ease: [0.22, 1, 0.36, 1] as const },
    // #root is a flex row; make each world span the full width.
    style: { flex: 1, minWidth: 0, width: '100%' },
  };

  // Checked before anything else renders, and before any provider starts polling
  // the chain: in an incident the first job is to stop new deposits.
  if (IN_MAINTENANCE) return <MaintenanceNotice />;

  return (
    <>
      <AnimatePresence mode="wait">
        {world === 'landing' && (
          <motion.div key="landing" {...fade}>
            <ErrorBoundary>
              <Suspense fallback={<PageLoader />}>
                <LandingView onLaunch={enterApp} />
              </Suspense>
            </ErrorBoundary>
          </motion.div>
        )}
        {world === 'trade' && (
          <motion.div key="trade" {...fade}>
            <Layout activeTab={activeTab} setActiveTab={navigate}>
              {/* Keyed on the tab so recovering from an error on one view doesn't
                  leave the next one stuck in the failed state. The chrome stays
                  mounted either way, so cancel/withdraw remain reachable. */}
              <ErrorBoundary key={activeTab}>
                <Suspense fallback={<PageLoader />}>
                  {renderContent()}
                </Suspense>
              </ErrorBoundary>
            </Layout>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

export default App;
