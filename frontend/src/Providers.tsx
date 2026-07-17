import { ApiProvider, AccountProvider } from '@gear-js/react-hooks';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NODE_ADDRESS } from './consts';
import { ToastProvider } from './components/ui/Toast';
import { MarketDataProvider } from './providers/MarketDataProvider';
import { VoucherProvider } from './providers/VoucherProvider';

const queryClient = new QueryClient();

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ApiProvider initialArgs={{ endpoint: NODE_ADDRESS }}>
        <AccountProvider appName="thebookdex">
          <VoucherProvider>
            <MarketDataProvider>
              <ToastProvider>
                {children}
              </ToastProvider>
            </MarketDataProvider>
          </VoucherProvider>
        </AccountProvider>
      </ApiProvider>
    </QueryClientProvider>
  );
}
