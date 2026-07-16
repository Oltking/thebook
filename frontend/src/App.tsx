import { lazy, Suspense, useState } from 'react';
import { Layout } from './components/layout/Layout';
import { SkeletonCard } from './components/ui/Skeleton';
import { OnboardingWizard } from './components/ui/OnboardingWizard';
import { useOnboarding } from './hooks/useOnboarding';

const HomeView = lazy(() => import('./views/HomeView').then(m => ({ default: m.HomeView })));
const AgentView = lazy(() => import('./views/AgentView').then(m => ({ default: m.AgentView })));
const TradeView = lazy(() => import('./views/TradeView').then(m => ({ default: m.TradeView })));
const SwapView = lazy(() => import('./views/SwapView').then(m => ({ default: m.SwapView })));
const PoolsView = lazy(() => import('./views/PoolsView').then(m => ({ default: m.PoolsView })));
const PortfolioView = lazy(() => import('./views/PortfolioView').then(m => ({ default: m.PortfolioView })));
const LeaderboardView = lazy(() => import('./views/LeaderboardView').then(m => ({ default: m.LeaderboardView })));

function PageLoader() {
  return (
    <div style={{ padding: 24 }}>
      <SkeletonCard lines={6} />
    </div>
  );
}

function App() {
  const [activeTab, setActiveTab] = useState('home');
  const { showWizard, completeOnboarding, dismissWizard } = useOnboarding();

  const renderContent = () => {
    switch (activeTab) {
      case 'home':
        return <HomeView onNavigate={setActiveTab} />;
      case 'agent':
        return <AgentView />;
      case 'trade':
        return <TradeView mode="spot" />;
      case 'futures':
        return <TradeView mode="futures" />;
      case 'swap':
        return <SwapView />;
      case 'pools':
        return <PoolsView />;
      case 'leaderboard':
        return <LeaderboardView />;
      case 'portfolio':
        return <PortfolioView />;
      default:
        return <HomeView onNavigate={setActiveTab} />;
    }
  };

  return (
    <>
      <Layout activeTab={activeTab} setActiveTab={setActiveTab}>
        <Suspense fallback={<PageLoader />}>
          {renderContent()}
        </Suspense>
      </Layout>

      {showWizard && (
        <OnboardingWizard
          onComplete={completeOnboarding}
          onDismiss={dismissWizard}
          onNavigateToTab={setActiveTab}
        />
      )}
    </>
  );
}

export default App;
