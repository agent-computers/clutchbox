import { getPrincipal } from '@agent-computers/server/auth';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { SignIn as SignInView } from '../components/auth/sign-in';
import type { GetServices } from '../services';

export const metadata: Metadata = { title: 'Sign in · Agent Computers', robots: { index: false } };
// /sign-in.
export const signInPage = (getServices: GetServices) =>
  async function SignIn({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
    const params = await searchParams;
    const { error } = params;
    // A plain visit while signed in goes to the app. Any query, such as a signed OAuth login
    // request, stays here. The session is validated so a stale cookie cannot loop with /app.
    if (!Object.keys(params).length && (await getPrincipal((await getServices()).auth, await headers())))
      redirect('/app');
    return (
      <main id="main" className="mx-auto flex w-full max-w-xl justify-center px-5 py-12 sm:px-8">
        <SignInView failed={Boolean(error)} />
      </main>
    );
  };
