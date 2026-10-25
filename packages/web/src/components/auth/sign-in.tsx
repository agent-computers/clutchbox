'use client';
// Better Auth UI v1.7.30 SignIn, retaining its social-only view. MIT license: LICENSE.
import { Alert, AlertDescription } from '@agent-computers/ui/components/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@agent-computers/ui/components/card';
import { getProviderId } from '@better-auth-ui/core';
import { useAuth } from '@better-auth-ui/react';
import { ProviderButton } from './provider-button';

export function SignIn({ failed }: { failed: boolean }) {
  const { localization, socialProviders } = useAuth();
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-3xl">
          <h1>{localization.auth.signIn}</h1>
        </CardTitle>
        <CardDescription>Sign in or create an account with Google.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {failed && (
          <Alert variant="destructive">
            <AlertDescription>Google sign-in did not finish. Please try again.</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-col gap-3">
          {socialProviders?.map(provider => (
            <ProviderButton key={getProviderId(provider)} provider={provider} className="w-full" />
          ))}
        </div>
        <p className="text-sm text-muted-foreground">
          Google sign-in identifies your account. Connecting the browser extension is a separate step; signing in does
          not give us your browsing sessions.
        </p>
      </CardContent>
    </Card>
  );
}
