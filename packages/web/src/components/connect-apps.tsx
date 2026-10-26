'use client';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@agent-computers/ui/components/alert-dialog';
import { Button } from '@agent-computers/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@agent-computers/ui/components/card';
import { Input } from '@agent-computers/ui/components/input';
import { Label } from '@agent-computers/ui/components/label';
import { Textarea } from '@agent-computers/ui/components/textarea';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { api, type ConnectApp, connectAppsQuery } from '../lib/api';
import { CopyButton } from './copy-button';
import { Failure } from './failure';

// Connect apps: the organization's own apps, which send people here to sign in, join, and link their account, and
// get back their member ID. The client secret is shown once, right after registering.
export function ConnectApps() {
  const queryClient = useQueryClient();
  const { data: apps } = useQuery(connectAppsQuery);
  const nameId = useId();
  const urisId = useId();
  const [name, setName] = useState('');
  const [uris, setUris] = useState('');
  const [deleting, setDeleting] = useState<ConnectApp | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: connectAppsQuery.queryKey });
  const create = useMutation({
    mutationFn: () =>
      api<{ app: { id: string; name: string; secret: string } }>('/organization/connect-apps', 'POST', {
        name,
        redirectUris: uris.split(/\s+/).filter(Boolean),
      }),
    onSuccess: () => {
      setName('');
      setUris('');
    },
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/organization/connect-apps/${id}`, 'DELETE'),
    onSuccess: () => setDeleting(null),
    onSettled: refresh,
  });
  const made = create.data?.app;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Connect apps</h2>
        </CardTitle>
        <CardDescription>
          Your app sends people here to sign in, join this organization, and connect their browser, then gets back their
          member ID over OAuth (scope <code>connect</code>, PKCE). Read their synced sites with an API key.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <form
          className="grid gap-3"
          onSubmit={event => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <Label htmlFor={nameId}>App name</Label>
          <Input
            id={nameId}
            required
            maxLength={100}
            value={name}
            onChange={event => setName(event.target.value)}
            placeholder="Acme Assistant"
          />
          <Label htmlFor={urisId}>Redirect URIs, one per line</Label>
          <Textarea
            id={urisId}
            required
            value={uris}
            onChange={event => setUris(event.target.value)}
            placeholder="https://app.example.com/auth/clutchbox/callback"
          />
          <div>
            <Button type="submit" disabled={create.isPending || !name.trim() || !uris.trim()}>
              {create.isPending ? 'Registering…' : 'Register app'}
            </Button>
          </div>
        </form>
        {made && (
          <div className="grid gap-2">
            <p className="text-sm text-foreground">
              Copy the client secret for {made.name} now. It is shown only once; if you lose it, delete the app and
              register it again.
            </p>
            <div className="flex flex-wrap gap-3">
              <Input readOnly aria-label="Client ID" value={made.id} className="min-w-60 flex-1 font-mono" />
              <CopyButton text={made.id} label="Copy the client ID" />
            </div>
            <div className="flex flex-wrap gap-3">
              <Input readOnly aria-label="Client secret" value={made.secret} className="min-w-60 flex-1 font-mono" />
              <CopyButton text={made.secret} label="Copy the client secret" />
            </div>
          </div>
        )}
        <Failure error={create.error} />
        {!!apps?.length && (
          <ul className="grid divide-y">
            {apps.map(app => (
              <li key={app.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{app.name}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground">{app.id}</p>
                  <p className="text-sm text-muted-foreground">
                    {app.connections === 1 ? '1 person connected' : `${app.connections} people connected`}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    remove.reset();
                    setDeleting(app);
                  }}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <AlertDialog open={!!deleting} onOpenChange={open => !open && !remove.isPending && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its sign-ins stop working and its connections end. The people stay members of this organization.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Failure error={remove.error} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Keep it</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => deleting && remove.mutate(deleting.id)}
            >
              {remove.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
