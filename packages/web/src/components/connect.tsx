'use client';
import { Alert, AlertDescription } from '@clutchbox/ui/components/alert';
import { Button, buttonVariants } from '@clutchbox/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@clutchbox/ui/components/card';
import { Spinner } from '@clutchbox/ui/components/spinner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { api, type ConnectStatus, connectStatusQuery } from '../lib/api';
import { JoinDisclosure } from './join';

const POLL_MS = 3000;

// Back to the authorize request, which goes on to consent: through /oauth2/continue, after switching to the app's
// organization so the grant is for it.
function useContinue(oauthQuery: string) {
  return useMutation({
    mutationFn: async () => {
      await api('/connect/join', 'POST', { oauthQuery });
      const response = await fetch('/api/auth/oauth2/continue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ postLogin: true, oauth_query: oauthQuery }),
      });
      const { url } = (await response.json().catch(() => ({}))) as { url?: string };
      if (!response.ok || !url) throw new Error('Connecting did not finish. Start again from the app.');
      window.location.assign(url);
    },
  });
}

// /connect: a Connect app's authorize request, between sign-in and consent. Someone new joins the app's organization,
// then connects the extension to it; a returning member with a connected browser goes straight on.
export function ConnectSteps({ oauthQuery }: { oauthQuery: string }) {
  const queryClient = useQueryClient();
  const { data: status, isError } = useQuery({
    ...connectStatusQuery(oauthQuery),
    refetchInterval: query => (query.state.data?.member && !query.state.data.browser ? POLL_MS : false),
  });
  const join = useMutation({
    mutationFn: () => api('/connect/join', 'POST', { oauthQuery }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: connectStatusQuery(oauthQuery).queryKey }),
  });
  const proceed = useContinue(oauthQuery);
  const { mutate: goOn } = proceed;
  // A member whose browser syncs to the organization has nothing to do here.
  const started = useRef(false);
  const ready = !!status?.member && status.browser;
  useEffect(() => {
    if (ready && !started.current) {
      started.current = true;
      goOn();
    }
  }, [ready, goOn]);
  if (isError)
    return (
      <Alert variant="destructive">
        <AlertDescription>This connection request expired or is invalid. Start again from the app.</AlertDescription>
      </Alert>
    );
  if (!status || ready)
    return (
      <p className="flex items-center gap-2 text-foreground">
        <Spinner aria-hidden /> Connecting…
      </p>
    );
  const failure = join.error ?? proceed.error;
  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-3xl">
          <h1>{status.member ? `Connect your browser to ${status.organization}` : `Join ${status.organization}`}</h1>
        </CardTitle>
        <CardDescription>
          {status.app.name} uses Clutchbox to sign its agents in to your sites, through {status.organization}.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {!status.member ? (
          <>
            <JoinDisclosure organization={status.organization} />
            <div>
              <Button size="lg" disabled={join.isPending} onClick={() => join.mutate()}>
                {join.isPending ? 'Joining…' : `Join ${status.organization}`}
              </Button>
            </div>
          </>
        ) : (
          <BrowserStep status={status} skip={() => goOn()} skipping={proceed.isPending} />
        )}
        {failure && (
          <Alert variant="destructive">
            <AlertDescription>{failure.message}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

function BrowserStep({ status, skip, skipping }: { status: ConnectStatus; skip: () => void; skipping: boolean }) {
  return (
    <>
      <ol className="grid list-decimal gap-2 pl-5 text-sm">
        <li>
          Install the Clutchbox extension, or open it if you have it.{' '}
          <a className="underline underline-offset-4" href="/app/sync" target="_blank" rel="noopener">
            How to install
          </a>
        </li>
        <li>In the extension, choose Agree and connect, then add the sites {status.app.name} should use.</li>
      </ol>
      <p className="flex items-center gap-2 text-sm text-foreground" aria-live="polite">
        <Spinner aria-hidden /> Waiting for your browser to connect. This page goes on by itself.
      </p>
      <div>
        <button type="button" className={buttonVariants({ variant: 'ghost' })} disabled={skipping} onClick={skip}>
          Skip for now
        </button>
      </div>
    </>
  );
}
