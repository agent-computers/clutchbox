'use client';
import { type AuthSocialProvider, getProviderName, isReauthenticationRequiredError } from '@better-auth-ui/core';
import { renderProviderIcon, useAuth, useLinkSocial, useListAccounts, useUnlinkAccount } from '@better-auth-ui/react';
// Better Auth UI v1.7.30 LinkedAccounts and LinkedAccount, adapted to the deployment's sign-in methods, email links,
// and inline errors. MIT license: LICENSE.
import type { SignInMethods as Methods, SignInProvider } from '@clutchbox/server/config';
import { Alert, AlertDescription } from '@clutchbox/ui/components/alert';
import { Button } from '@clutchbox/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@clutchbox/ui/components/card';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from '@clutchbox/ui/components/item';
import { Skeleton } from '@clutchbox/ui/components/skeleton';
import { Spinner } from '@clutchbox/ui/components/spinner';
import { KeyRound, Mail, Plug } from 'lucide-react';
import { Fragment } from 'react';
import { useAppSignOut } from './user-button';

const settings = '/app/settings';
// The error codes Better Auth adds to Settings when connecting fails, in words; any other gets the generic message.
const failures: Record<string, string> = {
  email_does_not_match: 'That account uses a different email address. Connect one that uses this account’s address.',
  unable_to_link_account: 'Your sign-in provider has not verified that account’s email address. Verify it there first.',
  account_already_linked_to_different_user: 'That account already signs in to another account here.',
};

const providerOf = (provider: SignInProvider): AuthSocialProvider =>
  typeof provider === 'string' ? provider : { ...provider, icon: <KeyRound /> };
const idOf = (provider: SignInProvider) => (typeof provider === 'string' ? provider : provider.id);

// The ways to sign in to this account: each provider the deployment offers, connected or not, and email links, which
// always work for the account's address. A provider can be removed unless it is the only way left.
export function SignInMethods({
  methods,
  email,
  error,
}: {
  methods: Methods;
  email: string;
  error?: string | undefined;
}) {
  const { authClient } = useAuth();
  const accounts = useListAccounts(authClient);
  const connected = accounts.data ?? [];
  const canRemove = connected.length > 1 || methods.emailLink;
  // An account whose provider the deployment no longer offers still shows, so it can be removed.
  const offered = new Set<string>(methods.providers.map(idOf));
  const rows = [
    ...methods.providers.map(provider => ({
      key: idOf(provider),
      provider: providerOf(provider),
      account: connected.find(account => account.providerId === idOf(provider)),
    })),
    ...connected
      .filter(account => !offered.has(account.providerId))
      .map(account => ({ key: account.id, provider: account.providerId as AuthSocialProvider, account })),
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Sign-in methods</h2>
        </CardTitle>
        <CardDescription>
          Every way to sign in to this account. Each one uses <strong>{email}</strong>.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{failures[error] ?? 'Connecting did not finish. Please try again.'}</AlertDescription>
          </Alert>
        )}
        {accounts.isError && (
          <Alert variant="destructive">
            <AlertDescription>Your sign-in methods could not be loaded. Reload to try again.</AlertDescription>
          </Alert>
        )}
        <ItemGroup className="gap-0">
          {rows.map((row, index) => (
            <Fragment key={row.key}>
              {index > 0 && <ItemSeparator />}
              {accounts.isPending ? (
                <MethodSkeleton />
              ) : (
                <Method provider={row.provider} accountId={row.account?.id} canRemove={canRemove} />
              )}
            </Fragment>
          ))}
          {methods.emailLink && (
            <>
              {rows.length > 0 && <ItemSeparator />}
              <Item className="px-0">
                <ItemMedia variant="icon">
                  <Mail />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>Email link</ItemTitle>
                  <ItemDescription>A link sent to {email}, from the sign-in page</ItemDescription>
                </ItemContent>
              </Item>
            </>
          )}
        </ItemGroup>
      </CardContent>
    </Card>
  );
}

function Method({
  provider,
  accountId,
  canRemove,
}: {
  provider: AuthSocialProvider;
  accountId: string | undefined;
  canRemove: boolean;
}) {
  const { authClient, baseURL } = useAuth();
  const link = useLinkSocial(authClient);
  const unlink = useUnlinkAccount(authClient, { meta: { errorPresentation: 'inline' } });
  // Removing needs a recent sign-in (Better Auth's fresh session); signing in again comes back here.
  const signOut = useAppSignOut(settings);
  const name = getProviderName(provider);
  const icon = renderProviderIcon(provider);
  const linking = link.isPending || link.isSuccess;
  return (
    <Item className="flex-wrap px-0">
      <ItemMedia variant="icon" className={accountId ? undefined : 'opacity-50'}>
        {icon ?? <Plug />}
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{name}</ItemTitle>
        <ItemDescription>{accountId ? 'Connected' : 'Not connected'}</ItemDescription>
      </ItemContent>
      <ItemActions>
        {accountId ? (
          <Button
            variant="secondary"
            disabled={unlink.isPending || !canRemove}
            title={canRemove ? undefined : 'This is the only way to sign in to this account.'}
            aria-label={`Remove ${name}`}
            onClick={() => unlink.mutate({ accountId })}
          >
            {unlink.isPending && <Spinner />}
            Remove
          </Button>
        ) : (
          <Button
            variant="secondary"
            disabled={linking}
            aria-label={`Connect ${name}`}
            onClick={() =>
              link.mutate({
                provider: typeof provider === 'string' ? provider : provider.id,
                callbackURL: `${baseURL}${settings}`,
                // Better Auth adds the error code, which Settings explains (failures).
                errorCallbackURL: `${baseURL}${settings}`,
              })
            }
          >
            {linking && <Spinner />}
            Connect
          </Button>
        )}
      </ItemActions>
      {link.isError && (
        <p role="alert" className="basis-full text-sm text-destructive">
          {name} is unavailable right now. Please try again.
        </p>
      )}
      {unlink.isError &&
        (isReauthenticationRequiredError(unlink.error) ? (
          <div role="alert" className="grid basis-full gap-3 rounded-lg bg-muted p-4 text-sm">
            <p>To remove a sign-in method, sign in again first. You’ll come back here.</p>
            <div>
              <Button
                variant="secondary"
                disabled={signOut.isPending || signOut.isSuccess}
                onClick={() => signOut.mutate()}
              >
                Sign in again
              </Button>
            </div>
          </div>
        ) : (
          <p role="alert" className="basis-full text-sm text-destructive">
            {name} could not be removed. Please try again.
          </p>
        ))}
    </Item>
  );
}

function MethodSkeleton() {
  return (
    <Item className="px-0">
      <ItemMedia>
        <Skeleton className="size-8 rounded-md" />
      </ItemMedia>
      <ItemContent>
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-3 w-24" />
      </ItemContent>
    </Item>
  );
}
