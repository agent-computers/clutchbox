'use client';
import { Alert, AlertDescription } from '@agent-computers/ui/components/alert';
import { Button } from '@agent-computers/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@agent-computers/ui/components/card';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, type Browser, browsersQuery, computerQuery, setupQuery, syncQuery } from '../lib/api';

const browserNames = { chrome: 'Chrome', edge: 'Edge', opera: 'Opera' } as const;
const platformNames = { macos: 'macOS', windows: 'Windows', linux: 'Linux', chromeos: 'ChromeOS' } as const;
const label = ({ browser, platform }: Browser) => {
  const name = browser ? browserNames[browser] : 'Browser';
  return platform ? `${name} on ${platformNames[platform]}` : name;
};
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

// Browsers connected with OAuth, apart from agents. Disconnecting one revokes its tokens and deletes the
// synced copy if that browser sent it.
export function ConnectedBrowsers() {
  const queryClient = useQueryClient();
  const { data } = useQuery(browsersQuery);
  const browsers = data?.browsers ?? [];
  // A browser already gone counts as disconnected.
  const disconnect = useMutation({
    mutationFn: (id: string) =>
      api('/browsers/disconnect', 'POST', { id }).catch(error => {
        if (!(error instanceof ApiError && error.status === 404)) throw error;
      }),
    onSettled: () =>
      Promise.all(
        [browsersQuery, syncQuery, setupQuery, computerQuery].map(query =>
          queryClient.invalidateQueries({ queryKey: query.queryKey }),
        ),
      ),
  });
  return (
    <Card id="browsers" className="scroll-mt-6">
      <CardHeader>
        <CardTitle>
          <h2>Browsers</h2>
        </CardTitle>
        <CardDescription>
          Browsers that sync to this account. Disconnecting one stops it and deletes what it uploaded.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {browsers.length ? (
          <ul className="border-t text-sm">
            {browsers.map(browser => (
              <li
                key={browser.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b py-2"
              >
                <span className="min-w-0">
                  {label(browser)}
                  <span className="text-muted-foreground">
                    {' '}
                    · Connected {when(browser.connectedAt)} ·{' '}
                    {browser.lastSyncedAt ? `Last synced ${when(browser.lastSyncedAt)}` : 'Has not synced yet'}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  aria-label={`Disconnect ${label(browser)} (connected ${when(browser.connectedAt)})`}
                  disabled={disconnect.isPending}
                  onClick={() => disconnect.mutate(browser.id)}
                >
                  Disconnect
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          data && (
            <p className="text-sm text-muted-foreground">No browser is connected. Connect one from the extension.</p>
          )
        )}
        {disconnect.isError && (
          <Alert variant="destructive">
            <AlertDescription>{disconnect.error.message}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
