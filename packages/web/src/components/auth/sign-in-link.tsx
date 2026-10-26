'use client';
import { useAuth, useSession } from '@better-auth-ui/react';
import Link from 'next/link';

// A call to sign in: a link to the sign-in page, which offers every method the deployment has, and returns to `next`
// (a path the sign-in page accepts) or the app. With `signedIn`, a signed-in visitor gets a link with that text
// straight there instead. The page renders signed out, then checks the session in the browser, so static pages stay
// static.
export function SignInLink({
  children,
  signedIn,
  next,
  className,
}: {
  children: React.ReactNode;
  signedIn?: React.ReactNode;
  next?: string;
  className?: string | undefined;
}) {
  const { authClient, basePaths, viewPaths, redirectTo } = useAuth();
  const session = useSession(authClient, { enabled: signedIn !== undefined });
  if (signedIn !== undefined && session.data)
    return (
      <Link href={next ?? redirectTo} className={className}>
        {signedIn}
      </Link>
    );
  const signIn = `${basePaths.auth}/${viewPaths.auth.signIn}`;
  return (
    <Link href={next ? `${signIn}?${new URLSearchParams({ next })}` : signIn} className={className}>
      {children}
    </Link>
  );
}
