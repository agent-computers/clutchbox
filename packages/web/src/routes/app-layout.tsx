import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppShell } from '../components/app-shell';
import { type ShellExtras, ShellProvider } from '../deployment';
import { apiGet, type Me, type PageApi } from '../lib/page-api';

export const metadata: Metadata = { robots: { index: false } };
// The signed-in app, under /app, in the deployment's shell. Its API routes check the session and membership
// themselves; this sends a visitor without a valid session to sign-in, and one in no organization here to /join,
// before anything renders.
export const appLayout = (api: PageApi, shell: ShellExtras = {}) =>
  async function AppLayout({ children }: { children: ReactNode }) {
    const me = await apiGet<Me>(api, '/me');
    if (!me.ok) redirect('/sign-in');
    if (!me.data.organization) redirect('/join');
    return (
      <ShellProvider shell={shell}>
        <AppShell user={me.data.user}>{children}</AppShell>
      </ShellProvider>
    );
  };
