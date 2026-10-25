'use client';
// Better Auth UI v1.7.30 ProviderButton, adapted for redirect-only Google sign-in and our CTA styles.
// Source: https://github.com/better-auth-ui/better-auth-ui/tree/v1.7.30/examples/start-shadcn-baseui-example/src/components/auth.
// Upstream MIT license: LICENSE.
import { Button, buttonVariants } from '@agent-computers/ui/components/button';
import { Spinner } from '@agent-computers/ui/components/spinner';
import {
  type AuthSocialProvider,
  authMutationKeys,
  getAuthCallbackURL,
  getProviderId,
  getProviderName,
  getSafeRedirectTo,
} from '@better-auth-ui/core';
import { renderProviderIcon, useAuth, useSession, useSignInSocial } from '@better-auth-ui/react';
import { useIsMutating, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useId, useSyncExternalStore } from 'react';

const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;
const errorClass = {
  plain: 'auth-error',
  default: 'auth-error mt-3 text-sm text-destructive',
  text: 'auth-error absolute top-full right-0 z-20 mt-1 w-[min(18rem,calc(100vw-2.5rem))] rounded-lg bg-popover p-4 text-sm text-destructive',
};

export function ProviderButton({
  provider = 'google',
  appearance = 'default',
  label,
  signedIn,
  callbackURL,
  className,
}: {
  provider?: AuthSocialProvider;
  appearance?: 'default' | 'text' | 'plain';
  label?: string;
  // With a label, a signed-in visitor gets a link with it to where sign-in would have led, instead of sign-in.
  // The page renders signed out, then checks the session in the browser, so static pages stay static.
  signedIn?: string;
  callbackURL?: string;
  className?: string | undefined;
}) {
  const { authClient, baseURL, redirectTo, localization } = useAuth();
  const session = useSession(authClient, { enabled: !!signedIn });
  const signIn = useSignInSocial(authClient);
  const queryClient = useQueryClient();
  const signingIn = useIsMutating({ mutationKey: authMutationKeys.signIn.all }) > 0;
  const interactive = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  const errorId = useId();
  const pending = signingIn || signIn.isSuccess;
  const providerId = getProviderId(provider);
  const name = getProviderName(provider);
  const text =
    signIn.isPending || signIn.isSuccess
      ? `Opening ${name}…`
      : (label ?? localization.auth.continueWith.replace('{{provider}}', name));
  const onClick = () => {
    if (queryClient.isMutating({ mutationKey: authMutationKeys.signIn.all }) || signIn.isSuccess) return;
    signIn.mutate({
      provider: providerId,
      callbackURL: getAuthCallbackURL(baseURL, getSafeRedirectTo(callbackURL ?? redirectTo, window.location.origin)),
      errorCallbackURL: '/sign-in?error=oauth',
    });
  };
  if (signedIn && session.data)
    return (
      <div className="auth-control relative">
        <Link
          href={callbackURL ?? redirectTo}
          className={
            appearance === 'plain'
              ? className
              : buttonVariants({
                  variant: appearance === 'text' ? 'link' : 'default',
                  size: appearance === 'text' ? 'xs' : 'lg',
                  className: appearance === 'text' ? 'h-11 px-0 text-sm' : className,
                })
          }
        >
          {signedIn}
        </Link>
      </div>
    );
  const shared = {
    disabled: !interactive || pending,
    'aria-busy': pending,
    'aria-describedby': signIn.isError ? errorId : undefined,
    onClick,
  };
  return (
    <div className="auth-control relative">
      {appearance === 'plain' ? (
        <button type="button" className={className} {...shared}>
          {text}
        </button>
      ) : (
        <Button
          {...shared}
          variant={appearance === 'text' ? 'link' : 'default'}
          size={appearance === 'text' ? 'xs' : 'lg'}
          className={appearance === 'text' ? 'h-11 px-0 text-sm' : className}
        >
          {appearance === 'default' && (
            <span aria-hidden="true" className="inline-flex">
              {signIn.isPending ? <Spinner /> : renderProviderIcon(provider)}
            </span>
          )}
          {text}
        </Button>
      )}
      {signIn.isError && (
        <p id={errorId} role="alert" className={errorClass[appearance]}>
          Sign-in is unavailable right now. Please try again.
        </p>
      )}
      <noscript>
        <p className={errorClass[appearance]}>Enable JavaScript to sign in with {name}.</p>
      </noscript>
    </div>
  );
}
