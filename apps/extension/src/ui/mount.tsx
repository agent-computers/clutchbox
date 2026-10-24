import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { type ReactNode } from 'react';
import ReactDOM from 'react-dom/client';
import './style.css';

// The popup and the setup tab talk to their own service worker, so a failure is not worth retrying.
export function mount(app: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>{app}</QueryClientProvider>
    </React.StrictMode>,
  );
}
