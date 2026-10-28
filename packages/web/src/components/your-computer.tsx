'use client';
import { COMPUTER_SIZE_NAMES, type ComputerSize, sizeName } from '@agent-computers/computer';
import { Alert, AlertDescription } from '@agent-computers/ui/components/alert';
import { Button } from '@agent-computers/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@agent-computers/ui/components/card';
import { ToggleGroup, ToggleGroupItem } from '@agent-computers/ui/components/toggle-group';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type ComputerView, computerQuery, grantsQuery } from '../lib/api';
import { computerStatus, resetsOn, syncedSignIns, usedShare } from '../lib/computer';
import { lastUser } from './agent-connections';
import { AppPage } from './app-shell';
import { LiveViewPanel } from './live-view';

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
// The Computer page: status and usage, live view in place, size, and reset.
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
            forks={view.forks}
            metered={!!view.usage}
            exhausted={
              view.usage?.hardStop && view.usage.usedShare >= 1
                ? {
                    message: `This month's computer credit is used up. It resets on ${resetsOn(view.usage.resetsAt)}.`,
                  }
                : null
            }
          />
          <ComputerSizeCard view={view} />
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
    // Only with a credit (the metering hook).
    ...(usage
      ? [
          {
            label: 'Computer credit',
            value: `${usage.cost} of ${usage.credit}`,
            note: `This month · resets ${resetsOn(usage.resetsAt)}${usage.estimate ? ` · estimated bill ${usage.estimate}` : ''}`,
            bar: usedShare(usage),
          },
        ]
      : []),
    // On the organization's own provider account, which bills it directly, so no credit applies.
    ...(view.account === 'organization'
      ? [{ label: 'Runs on', value: "Your organization's own account", note: 'Its provider bills it directly' }]
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

// Chooses the main computer's size. A computer keeps its size, so changing it resets an existing computer onto the new
// one, after a confirmation; with no computer yet it only sets the size the first one is created at.
function ComputerSizeCard({ view }: { view: ComputerView }) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<ComputerSize | null>(null);
  const change = useMutation({
    mutationFn: (size: ComputerSize) => api('/computer/size', 'PUT', { size }),
    onSuccess: () => {
      setPending(null);
      return queryClient.invalidateQueries({ queryKey: computerQuery.queryKey });
    },
  });
  const current = view.computer?.size ?? view.size;
  const shown = pending ?? current;
  return (
    <Card id="size" className="scroll-mt-6">
      <CardHeader>
        <CardTitle>
          <h2>Computer size</h2>
        </CardTitle>
        <CardDescription>
          More CPUs and memory for heavy sites and many tabs.
          {view.usage &&
            ' A larger computer uses your credit faster, at its cost: twice the CPUs and memory, twice the rate.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <ToggleGroup
          aria-label="Computer size"
          variant="outline"
          spacing={0}
          value={[shown]}
          disabled={change.isPending}
          onValueChange={([next]) => {
            if (!next || next === shown) return;
            change.reset();
            const size = next as ComputerSize;
            if (size === current) setPending(null);
            else if (view.computer) setPending(size);
            else change.mutate(size);
          }}
        >
          {COMPUTER_SIZE_NAMES.map(size => (
            <ToggleGroupItem key={size} value={size} className="h-auto flex-col items-start gap-0 px-4 py-2">
              <span className="font-medium">{size}</span>
              <span className="text-xs text-muted-foreground">{sizeName(size)}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {pending && (
          <div className="grid gap-3 rounded-lg bg-muted p-4">
            <p className="text-sm">
              Changing to {pending} resets your computer onto the new size. Its files and every sign-in made on it are
              deleted, and an agent using it now stops. Your synced sites come back the next time an agent opens it.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button variant="destructive" disabled={change.isPending} onClick={() => change.mutate(pending)}>
                {change.isPending ? 'Changing…' : `Change to ${pending}`}
              </Button>
              <Button variant="secondary" disabled={change.isPending} onClick={() => setPending(null)}>
                Keep {current}
              </Button>
            </div>
          </div>
        )}
        {change.isError && (
          <Alert variant="destructive">
            <AlertDescription>{change.error.message}</AlertDescription>
          </Alert>
        )}
      </CardContent>
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
