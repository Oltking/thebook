import { lazy, Suspense, useState } from 'react';
import { Layout } from './components/layout/Layout';
import { SkeletonCard } from './components/ui/Skeleton';
import { OnboardingWizard } from './components/ui/OnboardingWizard';
import { useOnboarding } from './hooks/useOnboarding';

const TradeView = lazy(() => import('./views/TradeView').then(m => ({ default: m.TradeView })));
const SwapView = lazy(() => import('./views/SwapView').then(m => ({ default: m.SwapView })));
const PoolsView = lazy(() => import('./views/PoolsView').then(m => ({ default: m.PoolsView })));
const PortfolioView = lazy(() => import('./views/PortfolioView').then(m => ({ default: m.PortfolioView })));
const AgentApiView = lazy(() => import('./views/AgentApiView').then(m => ({ default: m.AgentApiView })));
const HiveView = lazy(() => import('./views/hive/HiveView').then(m => ({ default: m.HiveView })));

function PageLoader() {
  return (
    <div style={{ padding: 24 }}>
      <SkeletonCard lines={6} />
    </div>
  );
}

function App() {
  const [activeTab, setActiveTab] = useState('trade');
  // Two worlds: the trading app and The Hive (agent ecosystem). The "Agent" nav
  // item crosses into the Hive; the Hive's own switch crosses back.
  const [mode, setMode] = useState<'trade' | 'hive'>('trade');
  const { showWizard, completeOnboarding, dismissWizard } = useOnboarding();

  const navigate = (tab: string) => {
    if (tab === 'agent') { setMode('hive'); return; }
    setActiveTab(tab);
  };

  const renderContent = () => {
    switch (activeTab) {
      case 'trade':
        return <TradeView mode="spot" />;
      case 'futures':
        return <TradeView mode="futures" />;
      case 'swap':
        return <SwapView />;
      case 'pools':
        return <PoolsView />;
      case 'portfolio':
        return <PortfolioView />;
      case 'build':
        return <AgentApiView />;
      default:
        return <TradeView mode="spot" />;
    }
  };

  return (
    <>
      {mode === 'hive' ? (
        <Suspense fallback={<PageLoader />}>
          <HiveView
            onExitHive={() => setMode('trade')}
            onDeploy={() => window.dispatchEvent(new Event('thebookdex:open-wizard'))}
          />
        </Suspense>
      ) : (
        <Layout activeTab={activeTab} setActiveTab={navigate} onEnterHive={() => setMode('hive')}>
          <Suspense fallback={<PageLoader />}>
            {renderContent()}
          </Suspense>
        </Layout>
      )}

      {showWizard && (
        <OnboardingWizard
          onComplete={completeOnboarding}
          onDismiss={dismissWizard}
          onNavigateToTab={(t) => { setMode('trade'); setActiveTab(t); }}
        />
      )}
    </>
  );
}

export default App;
