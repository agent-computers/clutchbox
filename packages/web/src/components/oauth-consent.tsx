'use client';
// Adapted from Better Auth UI v1.7.30, shadcn base-nova OAuthConsent (MIT).
// Source: https://github.com/better-auth-ui/better-auth-ui/tree/v1.7.30/examples/start-shadcn-baseui-example/src/components/auth.
// Adapted to our shared controls and tokens, keeping our computer-access descriptions and loopback notice.
// License: oauth-consent.LICENSE.
import { Alert, AlertDescription } from '@agent-computers/ui/components/alert';
import { Avatar, AvatarFallback, AvatarImage } from '@agent-computers/ui/components/avatar';
import { Button } from '@agent-computers/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@agent-computers/ui/components/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@agent-computers/ui/components/dropdown-menu';
import { Separator } from '@agent-computers/ui/components/separator';
import { Spinner } from '@agent-computers/ui/components/spinner';
import {
  getOAuthAuthorizationDestination,
  type OAuthProviderAuthClient,
  type OAuthScopeMetadataMap,
  parseOAuthAuthorizationRequest,
  resolveOAuthScopeMetadata,
  sanitizeOAuthClientUrl,
} from '@better-auth-ui/core/plugins/oauth-provider';
import { useAuth, useSignOut } from '@better-auth-ui/react';
import { useOAuthConsent } from '@better-auth-ui/react/plugins/oauth-provider';
import { useSetActiveOrganization } from '@better-auth-ui/react/plugins/organization';
import { useQueryClient } from '@tanstack/react-query';
import { AppWindow, Check, ChevronsUpDown, Ellipsis, Link as LinkIcon, Shield } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { authClient as appAuthClient } from '../lib/auth-client';
import { UserAvatar } from './auth/user-avatar';

type OAuthConsentProps = {
  /** Complete signed query, verified by the server before rendering this view. */
  oauthQuery: string;
  client: { name: string; logo: string | undefined; policy: string | undefined; terms: string | undefined };
  user: { name: string; email: string };
  scopeMetadata: OAuthScopeMetadataMap;
  loopback: boolean;
  clientHost: string;
  // The person's organizations; the grant is for the current one, which they may switch first.
  organizations: { id: string; name: string; current: boolean }[];
};

export function OAuthConsent({
  oauthQuery,
  client,
  user,
  scopeMetadata,
  loopback,
  clientHost,
  organizations,
}: OAuthConsentProps) {
  // The server supplies verified request and user data; all auth controls share one client configuration.
  const { authClient } = useAuth<OAuthProviderAuthClient>();
  const request = parseOAuthAuthorizationRequest(oauthQuery);
  const consent = useOAuthConsent(authClient, {
    onSuccess: result => {
      if (!result.url) throw new Error('Missing authorization redirect');
    },
  });
  // Each account has its own computer, so authorizing the wrong one connects the agent to a computer with
  // none of the user's sign-ins. Switching signs out and returns to sign-in with the request intact.
  const queryClient = useQueryClient();
  const switchAccount = useSignOut(authClient, {
    onSuccess: () => {
      queryClient.clear();
      window.location.assign(`/sign-in?${oauthQuery}`);
    },
  });
  const destination = getOAuthAuthorizationDestination(oauthQuery);
  const logoUrl = sanitizeOAuthClientUrl(client.logo);
  const policyUrl = sanitizeOAuthClientUrl(client.policy);
  const termsUrl = sanitizeOAuthClientUrl(client.terms);
  // A grant is for one organization: the one the person acts in, which they can switch here before allowing.
  const router = useRouter();
  const switchOrganization = useSetActiveOrganization(appAuthClient, { onSuccess: () => router.refresh() });
  const current = organizations.find(organization => organization.current);
  const pending =
    consent.isPending ||
    consent.isSuccess ||
    switchAccount.isPending ||
    switchAccount.isSuccess ||
    switchOrganization.isPending;

  return (
    <Card className="max-h-[calc(100dvh-8rem)] w-full gap-0 py-0">
      <section
        className="min-h-0 overflow-y-auto overscroll-contain focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        aria-label={`Authorize ${client.name}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users must be able to scroll through every permission.
        tabIndex={0}
      >
        <CardHeader className="gap-5 p-6">
          <div className="flex items-center justify-center gap-5">
            <Avatar className="size-16">
              <AvatarImage alt={client.name} referrerPolicy="no-referrer" src={logoUrl} />
              <AvatarFallback>
                <AppWindow aria-hidden="true" className="size-7" />
              </AvatarFallback>
            </Avatar>
            <Ellipsis aria-hidden="true" className="size-5 text-muted-foreground" />
            <UserAvatar user={user} className="size-16" />
          </div>
          <div className="grid justify-items-center gap-1 text-center">
            <CardTitle className="max-w-full text-3xl wrap-break-word">
              <h1>{client.name}</h1>
            </CardTitle>
            <CardDescription>wants to access your Clutchbox account</CardDescription>
            <p className="mt-2 max-w-full text-sm text-muted-foreground">
              Signed in as <span className="break-all font-medium text-foreground">{user.email}</span>
            </p>
            <Button
              variant="link"
              disabled={pending}
              onClick={() => switchAccount.mutate()}
              className="text-sm whitespace-normal"
            >
              {switchAccount.isPending && <Spinner />}
              Not you? Use another account
            </Button>
            {current && organizations.length > 1 && (
              <div className="mt-1 flex flex-wrap items-center justify-center gap-2 text-sm text-muted-foreground">
                For
                <DropdownMenu>
                  <DropdownMenuTrigger
                    disabled={pending}
                    aria-label={`Organization: ${current.name}. Change`}
                    render={<Button variant="secondary" size="sm" />}
                  >
                    {switchOrganization.isPending && <Spinner />}
                    <span className="max-w-48 truncate">{current.name}</span>
                    <ChevronsUpDown aria-hidden />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="center" className="min-w-48">
                    <DropdownMenuRadioGroup
                      value={current.id}
                      onValueChange={id =>
                        id !== current.id && switchOrganization.mutate({ organizationId: id as string })
                      }
                    >
                      {organizations.map(organization => (
                        <DropdownMenuRadioItem
                          closeOnClick
                          key={organization.id}
                          value={organization.id}
                          className="min-h-11"
                        >
                          {organization.name}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
            {switchOrganization.isError && (
              <p role="alert" className="text-sm text-destructive">
                The organization did not change. Please try again.
              </p>
            )}
          </div>
        </CardHeader>
        <CardContent className="px-4 pb-6 sm:px-6">
          <div className="flex flex-col gap-5 rounded-lg bg-muted/50 p-5">
            <div className="grid gap-3">
              <p className="text-sm font-medium">This will allow {client.name} to:</p>
              <ul className="grid gap-3">
                {request.scopes.map(scope => {
                  const metadata = resolveOAuthScopeMetadata(scopeMetadata, scope, {
                    ...(request.clientId ? { clientId: request.clientId } : {}),
                    requestedScopes: request.scopes,
                  });
                  return (
                    <li className="flex gap-3" key={scope}>
                      <Check aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                      <div className="grid min-w-0 gap-1">
                        <p className="text-base leading-6 wrap-break-word">{metadata.label}</p>
                        {metadata.description && (
                          <p className="text-sm leading-5 text-muted-foreground">{metadata.description}</p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
            <Separator />
            {destination && (
              <div className="flex gap-3 text-sm leading-5 text-muted-foreground">
                <LinkIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                <p>
                  Authorizing will redirect you to
                  <span className="block break-all font-medium text-foreground">{destination}</span>
                </p>
              </div>
            )}
            {loopback && (
              <p role="note" className="text-sm leading-5 text-foreground">
                This agent runs on your own device. Only allow it if you started this connection yourself just now.
              </p>
            )}
            <p className="break-all text-sm text-muted-foreground">Client identifier: {clientHost}</p>
            {(policyUrl || termsUrl) && (
              <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
                {policyUrl && (
                  <a className="underline underline-offset-4" href={policyUrl} rel="noreferrer" target="_blank">
                    Privacy policy
                  </a>
                )}
                {termsUrl && (
                  <a className="underline underline-offset-4" href={termsUrl} rel="noreferrer" target="_blank">
                    Terms of service
                  </a>
                )}
              </div>
            )}
            <div className="flex gap-3 text-sm leading-5 text-muted-foreground">
              <Shield aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <p>
                Application names and logos are provided by their developers. Only authorize applications you trust.
              </p>
            </div>
            <p className="text-sm leading-5 text-foreground">
              Access is limited to your account and this agent connection. You can disconnect any agent from your
              account at any time.
            </p>
          </div>
        </CardContent>
      </section>
      <CardFooter className="grid shrink-0 grid-cols-2 gap-3 p-4 sm:p-6">
        {switchAccount.isError && (
          <Alert variant="destructive" className="col-span-2">
            <AlertDescription>Signing out failed. Please try again.</AlertDescription>
          </Alert>
        )}
        {consent.isError && (
          <Alert variant="destructive" className="col-span-2">
            <AlertDescription>
              This connection request could not be completed. Try again, or start the connection again from your agent.
            </AlertDescription>
          </Alert>
        )}
        <noscript className="col-span-2">Enable JavaScript to allow or cancel this connection.</noscript>
        <Button
          disabled={pending}
          variant="secondary"
          onClick={() => consent.mutate({ accept: false, oauth_query: oauthQuery })}
        >
          {consent.isPending && consent.variables?.accept === false && <Spinner />}
          Cancel
        </Button>
        <Button disabled={pending} onClick={() => consent.mutate({ accept: true, oauth_query: oauthQuery })}>
          {consent.isPending && consent.variables?.accept === true && <Spinner />}
          Authorize
        </Button>
      </CardFooter>
    </Card>
  );
}
