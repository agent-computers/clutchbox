import { getPrincipal } from '@agent-computers/server/auth';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppShell } from '../components/app-shell';
import { type ShellExtras, ShellProvider } from '../deployment';
import type { GetServices } from '../services';

export const metadata: Metadata = { robots: { index: false } };
// The signed-in app, under /app, in the deployment's shell. Its API routes check the session themselves; this sends a
// visitor without a valid one to sign-in before anything renders.
export const appLayout = (getServices: GetServices, shell: ShellExtras = {}) =>
  async function AppLayout({ children }: { children: ReactNode }) {
    const { auth } = await getServices();
    const principal = await getPrincipal(auth, await headers());
    if (!principal) redirect('/sign-in');
    return (
      <ShellProvider shell={shell}>
        <AppShell user={principal}>{children}</AppShell>
      </ShellProvider>
    );
  };
