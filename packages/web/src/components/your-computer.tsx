'use client';
import { Alert, AlertDescription } from '@agent-computers/ui/components/alert';
import { Button } from '@agent-computers/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@agent-computers/ui/components/card';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type ComputerView, computerQuery, grantsQuery } from '../lib/api';
import { computerStatus, resetsOn, syncedSignIns } from '../lib/computer';
import { lastUser } from './agent-connections';
import { AppPage } from './app-shell';
import { LiveViewPanel } from './live-view';

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
// The Computer page: status and usage, live view in place, and reset.
export function YourComputer() {
  const { data: view, isError } = useQuery(computerQuery);
  return (
    <AppPage
      wide
      title="Your computer"
      description="A Linux desktop with a browser, signed in from yours. It sleeps when idle and wakes when it's opened."
    >
      {view ? (
        <>
          <ComputerStats view={view} />
          <LiveViewPanel
            metered={!!view.usage}
            exhausted={
              view.usage && view.usage.usedMinutes >= view.usage.allowanceMinutes
                ? { resetsAt: view.usage.resetsAt }
                : null
            }
          />
          {view.computer && <ResetComputer />}
        </>
      ) : (
        <p className="text-foreground">{isError ? 'Your computer could not load. Reload to try again.' : 'Loading…'}</p>
      )}
    </AppPage>
  );
}

function ComputerStats({ view }: { view: ComputerView }) {
  const { data: grants = [] } = useQuery(grantsQuery);
  const status = computerStatus(view);
  const used = lastUser(grants);
  const synced = syncedSignIns(view);
  const { usage } = view;
  const stats = [
    { label: 'Status', value: status.short, note: status.note, dot: status.dot },
    // Only with a free allowance (the metering hook).
    ...(usage
      ? [
          {
            label: 'Free minutes',
            value: `${usage.usedMinutes} of ${usage.allowanceMinutes}`,
            note: `This month · resets ${resetsOn(usage.resetsAt)}`,
            bar: Math.min(100, (usage.usedMinutes / usage.allowanceMinutes) * 100),
          },
        ]
      : []),
    used
      ? { label: 'Last used by', value: used.name, note: when(used.at) }
      : { label: 'Last used by', value: 'No agent yet', note: 'Ask a connected agent to open it.' },
    synced
      ? {
          label: 'Synced sign-ins',
          value: when(synced.copiedAt),
          note: synced.applied ? 'On your computer' : 'Applied the next time it opens',
        }
      : { label: 'Synced sign-ins', value: 'None yet', note: 'Set up browser sync to add them.' },
  ];
  return (
    <Card className="grid grid-cols-1 gap-0 py-0 sm:grid-cols-2 lg:grid-cols-4">
      {stats.map(stat => (
        <div
          key={stat.label}
          className="grid content-start gap-1 border-foreground/10 p-4 not-last:max-sm:border-b sm:max-lg:nth-[-n+2]:border-b sm:max-lg:odd:border-r lg:not-last:border-r"
        >
          <span className="text-xs text-muted-foreground">{stat.label}</span>
          <span className="flex items-center gap-2 font-heading text-xl">
            {'dot' in stat && <span aria-hidden className={`size-2 shrink-0 rounded-full ${stat.dot}`} />}
            {stat.value}
          </span>
          {'bar' in stat && (
            <span className="h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
              <span className="block h-full rounded-full bg-foreground" style={{ width: `${stat.bar}%` }} />
            </span>
          )}
          <span className="text-xs text-muted-foreground">{stat.note}</span>
        </div>
      ))}
    </Card>
  );
}

// Rebuilds the computer from the current image; synced data and setup stay.
function ResetComputer() {
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const reset = useMutation({
    mutationFn: () => api('/computer/reset', 'POST'),
    onSuccess: () => {
      setConfirm(false);
      return queryClient.invalidateQueries({ queryKey: computerQuery.queryKey });
    },
  });
  return (
    <Card id="reset" className="scroll-mt-6">
      <CardHeader>
        <CardTitle>
          <h2>Reset computer</h2>
        </CardTitle>
        <CardDescription>
          Start over on the latest version of the computer, keeping your synced browser data.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {confirm ? (
          <div className="grid gap-3 rounded-lg bg-muted p-4">
            <p className="text-sm">
              This replaces your computer with a fresh one. Its files and every sign-in made on it are deleted, and an
              agent using it now stops. Your synced sites come back the next time an agent opens it.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button variant="destructive" disabled={reset.isPending} onClick={() => reset.mutate()}>
                {reset.isPending ? 'Resetting…' : 'Reset computer'}
              </Button>
              <Button variant="secondary" disabled={reset.isPending} onClick={() => setConfirm(false)}>
                Keep it
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <Button
              variant="outline"
              onClick={() => {
                reset.reset();
                setConfirm(true);
              }}
            >
              Reset computer…
            </Button>
          </div>
        )}
        {reset.isError && (
          <Alert variant="destructive">
            <AlertDescription>{reset.error.message}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
