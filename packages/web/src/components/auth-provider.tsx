'use client';
import type { NavigateFn } from '@better-auth-ui/core';
import { apiKeyPlugin } from '@better-auth-ui/core/plugins/api-key';
import { organizationPlugin } from '@better-auth-ui/core/plugins/organization';
import { AuthProvider as BetterAuthUIProvider } from '@better-auth-ui/react';
import { QueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { authClient } from '../lib/auth-client';

const emailAndPassword = { enabled: false };
const localization = { auth: { signIn: 'Sign in', signOut: 'Sign out' } };
const basePaths = { auth: '', settings: '' };
const viewPaths = { auth: { signIn: 'sign-in', signUp: 'sign-in' }, settings: { account: 'app/settings' } };
// The organization and API-key hooks read their plugin's settings; our pages render them, not the plugins' views.
const plugins = [organizationPlugin(), apiKeyPlugin({ organization: true })];

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // Explicitly supply a per-mount client; never use the library's module-level fallback during SSR.
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1 } } }));
  const router = useRouter();
  const navigate = useCallback<NavigateFn>(
    ({ to, replace }) => (replace ? router.replace(to) : router.push(to)),
    [router],
  );
  return (
    <BetterAuthUIProvider
      authClient={authClient}
      queryClient={queryClient}
      navigate={navigate}
      emailAndPassword={emailAndPassword}
      localization={localization}
      basePaths={basePaths}
      viewPaths={viewPaths}
      plugins={plugins}
      redirectTo="/app"
    >
      {children}
    </BetterAuthUIProvider>
  );
}
