'use client';
import {
  type AuthSocialProvider,
  authMutationKeys,
  getAuthCallbackURL,
  getProviderId,
  getProviderName,
  getSafeRedirectTo,
} from '@better-auth-ui/core';
import { renderProviderIcon, useAuth, useSignInSocial } from '@better-auth-ui/react';
// Better Auth UI v1.7.30 ProviderButton, adapted for redirect-only sign-in on the sign-in page.
// Source: https://github.com/better-auth-ui/better-auth-ui/tree/v1.7.30/examples/start-shadcn-baseui-example/src/components/auth.
// Upstream MIT license: LICENSE.
import { Button } from '@clutchbox/ui/components/button';
import { Spinner } from '@clutchbox/ui/components/spinner';
import { useIsMutating, useQueryClient } from '@tanstack/react-query';
import { useId, useSyncExternalStore } from 'react';

const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

// The provider is always named, so a button never offers one the deployment does not configure (signInMethods).
export function ProviderButton({
  provider,
  callbackURL,
  className,
}: {
  provider: AuthSocialProvider;
  callbackURL?: string | undefined;
  className?: string | undefined;
}) {
  const { authClient, baseURL, redirectTo, localization } = useAuth();
  const signIn = useSignInSocial(authClient);
  const queryClient = useQueryClient();
  const signingIn = useIsMutating({ mutationKey: authMutationKeys.signIn.all }) > 0;
  const interactive = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  const errorId = useId();
  const pending = signingIn || signIn.isSuccess;
  const name = getProviderName(provider);
  const onClick = () => {
    if (queryClient.isMutating({ mutationKey: authMutationKeys.signIn.all }) || signIn.isSuccess) return;
    signIn.mutate({
      provider: getProviderId(provider),
      callbackURL: getAuthCallbackURL(baseURL, getSafeRedirectTo(callbackURL ?? redirectTo, window.location.origin)),
      // Better Auth adds the error code, such as account_not_linked, which the sign-in page explains.
      errorCallbackURL: '/sign-in',
    });
  };
  return (
    <div className="relative">
      <Button
        size="lg"
        className={className}
        disabled={!interactive || pending}
        aria-busy={pending}
        aria-describedby={signIn.isError ? errorId : undefined}
        onClick={onClick}
      >
        <span aria-hidden="true" className="inline-flex">
          {signIn.isPending ? <Spinner /> : renderProviderIcon(provider)}
        </span>
        {signIn.isPending || signIn.isSuccess
          ? `Opening ${name}…`
          : localization.auth.continueWith.replace('{{provider}}', name)}
      </Button>
      {signIn.isError && (
        <p id={errorId} role="alert" className="mt-3 text-sm text-destructive">
          Sign-in is unavailable right now. Please try again.
        </p>
      )}
      <noscript>
        <p className="mt-3 text-sm text-destructive">Enable JavaScript to sign in with {name}.</p>
      </noscript>
    </div>
  );
}
