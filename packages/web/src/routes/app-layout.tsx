import { getPrincipal } from '@agent-computers/server/auth';
import { currentMember } from '@agent-computers/server/organizations';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppShell } from '../components/app-shell';
import { type ShellExtras, ShellProvider } from '../deployment';
import { repoStars } from '../lib/github';
import type { GetServices } from '../services';

export const metadata: Metadata = { robots: { index: false } };
// The signed-in app, under /app, in the deployment's shell. Its API routes check the session and membership
// themselves; this sends a visitor without a valid session to sign-in, and one in no organization here to /join,
// before anything renders.
export const appLayout = (getServices: GetServices, shell: ShellExtras = {}) =>
  async function AppLayout({ children }: { children: ReactNode }) {
    // Asked first, alongside the checks; a GitHub failure leaves the count out rather than failing the app.
    const stars = shell.githubRepo ? repoStars(shell.githubRepo).catch(() => null) : null;
    const { auth, db } = await getServices();
    const principal = await getPrincipal(auth, await headers());
    if (!principal) redirect('/sign-in');
    if (!(await currentMember(db, principal.id))) redirect('/join');
    return (
      <ShellProvider shell={shell}>
        <AppShell user={principal} stars={await stars}>
          {children}
        </AppShell>
      </ShellProvider>
    );
  };
