import { getPrincipal, signedOAuthClient } from '@agent-computers/server/auth';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ConnectSteps } from '../components/connect';
import type { GetServices } from '../services';

export const metadata: Metadata = { title: 'Connect · Clutchbox', robots: { index: false } };
const page = 'mx-auto flex w-full max-w-xl justify-center px-5 py-12 sm:px-8';

// /connect: where a Connect app's authorize request goes after sign-in, before consent (auth.ts, postLogin).
export const connectPage = (getServices: GetServices) =>
  async function Connect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(await searchParams))
      for (const entry of Array.isArray(value) ? value : value ? [value] : []) query.append(key, entry);
    const oauthQuery = query.toString();
    const { auth } = await getServices();
    if (!(await signedOAuthClient(auth, oauthQuery)))
      return (
        <main id="main" className={page}>
          <p className="text-foreground">This connection request expired or is invalid. Start again from the app.</p>
        </main>
      );
    if (!(await getPrincipal(auth, await headers()))) redirect(`/sign-in?${oauthQuery}`);
    return (
      <main id="main" className={page}>
        <ConnectSteps oauthQuery={oauthQuery} />
      </main>
    );
  };
