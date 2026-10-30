import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ResumeSignIn, SignIn as SignInView } from '../components/auth/sign-in';
import { apiData, apiGet, type Me, type PageApi, type SignInMethods } from '../lib/page-api';

export const metadata: Metadata = { title: 'Sign in · Clutchbox', robots: { index: false } };
// Where signing in may return to instead of the app: an invitation link or a page in the app, by a pattern that can't
// send anyone off-site.
const returnable = (next: unknown) =>
  typeof next === 'string' && /^\/(join\/[A-Za-z0-9_-]{1,100}|app(\/[a-z0-9-]{1,50}){0,3})$/.test(next)
    ? next
    : undefined;
// /sign-in.
export const signInPage = (api: PageApi) =>
  async function SignIn({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
    const params = await searchParams;
    const next = returnable(params.next);
    // A plain visit while signed in goes to the app, or back to the invitation it came from. Any other query, such as
    // a signed OAuth login request, stays here. The session is validated so a stale cookie cannot loop with /app.
    const plain = Object.keys(params).every(name => name === 'next');
    if (plain && (await apiGet<Me>(api, '/me')).ok) redirect(next ?? '/app');
    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(params))
      for (const each of Array.isArray(value) ? value : value === undefined ? [] : [value]) search.append(name, each);
    const resume = search.has('sig') ? await apiGet<{ href: string | null }>(api, `/oauth/resume?${search}`) : null;
    const href = resume?.ok ? resume.data.href : null;
    const methods = href ? null : await apiData<SignInMethods>(api, '/sign-in-methods');
    const error = search.get('error') ?? undefined;
    return (
      <main id="main" className="mx-auto flex w-full max-w-xl justify-center px-5 py-12 sm:px-8">
        {href ? (
          <ResumeSignIn href={href} />
        ) : (
          methods && <SignInView methods={methods} error={error} redirectTo={next} />
        )}
      </main>
    );
  };
