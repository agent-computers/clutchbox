'use client';
// Better Auth UI v1.7.30 SignIn, retaining its social view and adding an email link form. MIT license: LICENSE.
import type { SignInMethods } from '@agent-computers/server/config';
import { Alert, AlertDescription } from '@agent-computers/ui/components/alert';
import { Button } from '@agent-computers/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@agent-computers/ui/components/card';
import { Input } from '@agent-computers/ui/components/input';
import { Label } from '@agent-computers/ui/components/label';
import { Separator } from '@agent-computers/ui/components/separator';
import { Spinner } from '@agent-computers/ui/components/spinner';
import { getProviderId } from '@better-auth-ui/core';
import type { MagicLinkAuthClient } from '@better-auth-ui/core/plugins/magic-link';
import { useAuth } from '@better-auth-ui/react';
import { useSignInMagicLink } from '@better-auth-ui/react/plugins/magic-link';
import { KeyRound, Mail } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { ProviderButton } from './provider-button';

// The error codes Better Auth adds to /sign-in when sign-in fails, in words; any other gets the generic message.
const failures: Record<string, string> = {
  account_not_linked:
    'This email address already has an account that signs in another way. Sign in the way you did before.',
  email_not_verified:
    'Your sign-in provider has not verified that account’s email address. Verify it there, then try again.',
  email_not_found: 'Your sign-in provider did not share an email address, which an account needs.',
  INVALID_TOKEN: 'That sign-in link has expired or was already used. Request a new one.',
};

export function SignIn({ methods, error }: { methods: SignInMethods; error: string | undefined }) {
  const { localization } = useAuth();
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-3xl">
          <h1>{localization.auth.signIn}</h1>
        </CardTitle>
        <CardDescription>Sign in or create an account.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{failures[error] ?? 'Sign-in did not finish. Please try again.'}</AlertDescription>
          </Alert>
        )}
        {methods.providers.length > 0 && (
          <div className="flex flex-col gap-3">
            {methods.providers.map(provider => (
              <ProviderButton
                key={getProviderId(provider)}
                provider={typeof provider === 'string' ? provider : { ...provider, icon: <KeyRound /> }}
                className="w-full"
              />
            ))}
          </div>
        )}
        {methods.providers.length > 0 && methods.emailLink && <Separator />}
        {methods.emailLink && <EmailLink />}
        <p className="text-sm text-muted-foreground">
          Signing in identifies your account. Connecting the browser extension is a separate step; signing in does not
          give us your browsing sessions.
        </p>
      </CardContent>
    </Card>
  );
}

function EmailLink() {
  const { authClient, redirectTo } = useAuth<MagicLinkAuthClient>();
  const send = useSignInMagicLink(authClient);
  const [email, setEmail] = useState('');
  const fieldId = useId();
  if (send.isSuccess)
    return (
      <div className="grid gap-3">
        <p className="text-sm">
          We sent a sign-in link to <strong>{send.variables.email}</strong>. It works once, for 10 minutes.
        </p>
        <Button variant="secondary" onClick={() => send.reset()}>
          Use a different address
        </Button>
      </div>
    );
  return (
    <form
      className="grid gap-3"
      onSubmit={event => {
        event.preventDefault();
        // Mid-connect, the server sends the link back here instead, to continue (ResumeSignIn).
        send.mutate({ email, callbackURL: redirectTo, errorCallbackURL: '/sign-in' });
      }}
    >
      <Label htmlFor={fieldId}>Email</Label>
      <Input
        id={fieldId}
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={event => setEmail(event.target.value)}
      />
      <Button type="submit" size="lg" disabled={send.isPending} aria-busy={send.isPending}>
        <span aria-hidden="true" className="inline-flex">
          {send.isPending ? <Spinner /> : <Mail />}
        </span>
        Email me a sign-in link
      </Button>
      {send.isError && (
        <p role="alert" className="text-sm text-destructive">
          {send.error.status === 429
            ? 'Too many sign-in links were asked for. Try again in a few minutes.'
            : 'The sign-in link could not be sent. Please try again.'}
        </p>
      )}
    </form>
  );
}

// Signed in mid-connect by a method that comes back here (resumeAuthorization): continue the authorize request in
// this tab. Navigating from our page makes it the navigation's initiator, which the extension's connect page needs.
export function ResumeSignIn({ href }: { href: string }) {
  useEffect(() => window.location.replace(href), [href]);
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-3xl">
          <h1>Signed in</h1>
        </CardTitle>
        <CardDescription>Continuing where you left off…</CardDescription>
      </CardHeader>
      <CardContent>
        <Button nativeButton={false} render={<a href={href}>Continue</a>} className="w-full" size="lg" />
      </CardContent>
    </Card>
  );
}
