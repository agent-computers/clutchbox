import { getPrincipal, resumeAuthorization } from '@agent-computers/server/auth';
import { signInMethods } from '@agent-computers/server/config';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ResumeSignIn, SignIn as SignInView } from '../components/auth/sign-in';
import type { GetServices } from '../services';

export const metadata: Metadata = { title: 'Sign in · Agent Computers', robots: { index: false } };
// /sign-in.
export const signInPage = (getServices: GetServices) =>
  async function SignIn({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
    const params = await searchParams;
    const { auth, config } = await getServices();
    const requestHeaders = await headers();
    // A plain visit while signed in goes to the app. Any query, such as a signed OAuth login
    // request, stays here. The session is validated so a stale cookie cannot loop with /app.
    if (!Object.keys(params).length && (await getPrincipal(auth, requestHeaders))) redirect('/app');
    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(params))
      for (const each of Array.isArray(value) ? value : value === undefined ? [] : [value]) search.append(name, each);
    const resume = search.has('sig') ? await resumeAuthorization(auth, requestHeaders, search) : null;
    const error = search.get('error') ?? undefined;
    return (
      <main id="main" className="mx-auto flex w-full max-w-xl justify-center px-5 py-12 sm:px-8">
        {resume ? <ResumeSignIn href={resume} /> : <SignInView methods={signInMethods(config)} error={error} />}
      </main>
    );
  };
