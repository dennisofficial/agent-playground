'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { AuthInitializer } from '@/components/auth/auth-initializer';
import { ThemeProvider } from '@/components/theme/theme-provider';

/**
 * Client provider composition for the whole app:
 *  - TanStack Query (REST history + mutations; the SSE subscription merges into this same cache).
 *  - ThemeProvider (reflects/persists the `data-theme` the no-flash script already set).
 *  - AuthInitializer (one-time session probe).
 *
 * The QueryClient is created once per browser session via useState (never re-created on re-render).
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Live data arrives over SSE — keep history fresh but don't hammer on focus.
            staleTime: 15_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthInitializer />
        {children}
      </ThemeProvider>
    </QueryClientProvider>
  );
}
