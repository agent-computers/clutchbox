'use client';
// The API keys part adapts Better Auth UI v1.7.30's ApiKeys, CreateApiKeyDialog, and DeleteApiKeyDialog to our shared
// controls and inline errors, on its hooks. MIT license: auth/LICENSE.
import { Alert, AlertDescription } from '@agent-computers/ui/components/alert';
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
import { useCreateApiKey, useDeleteApiKey, useListApiKeys } from '@better-auth-ui/react/plugins/api-key';
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { organizationQuery } from '../lib/api';
import { authClient } from '../lib/auth-client';
import { AppPage } from './app-shell';
import { ConnectApps } from './connect-apps';
import { CopyButton } from './copy-button';
import { Failure } from './failure';
import { day, manages } from './organization';

// The Developers page: what lets a developer's servers and apps use the organization's members' synced sign-ins, with
// their consent. Owners and admins manage it.
export function Developers() {
  const { data, isError } = useQuery(organizationQuery);
  return (
    <AppPage
      title="Developers"
      description="Let your servers read your members' synced sign-ins, and let your app bring its users here to join."
    >
      {isError && (
        <Alert variant="destructive">
          <AlertDescription>Your organization could not load. Reload to try again.</AlertDescription>
        </Alert>
      )}
      {data &&
        (manages(data.role) ? (
          <>
            <ApiKeys organizationId={data.organization.id} />
            <ConnectApps />
          </>
        ) : (
          <p className="text-foreground">
            Owners and admins of {data.organization.name} create API keys and register Connect apps.
          </p>
        ))}
    </AppPage>
  );
}

// Keys for the organization's developers' servers, which read every member's latest capture over REST. The secret is
// shown once, right after creating it.
function ApiKeys({ organizationId }: { organizationId: string }) {
  const { data } = useListApiKeys(authClient, { query: { organizationId } });
  const keys = data?.apiKeys;
  const fieldId = useId();
  const [name, setName] = useState('');
  const [deleting, setDeleting] = useState<NonNullable<typeof keys>[number] | null>(null);
  const create = useCreateApiKey(authClient, { onSuccess: () => setName('') });
  const remove = useDeleteApiKey(authClient, { onSuccess: () => setDeleting(null) });
  const made = create.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>API keys</h2>
        </CardTitle>
        <CardDescription>
          A key lets your servers read any member's latest synced sign-ins over the REST API, to use in your own
          browsers. Members agreed to this when they joined. Keep keys secret, and delete one you no longer use.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <form
          className="grid gap-3"
          onSubmit={event => {
            event.preventDefault();
            create.mutate({ name: name.trim(), organizationId });
          }}
        >
          <Label htmlFor={fieldId}>Name</Label>
          <div className="flex flex-wrap gap-3">
            <Input
              id={fieldId}
              placeholder="Production server"
              required
              maxLength={100}
              value={name}
              onChange={event => setName(event.target.value)}
              className="min-w-60 flex-1"
            />
            <Button type="submit" disabled={create.isPending || !name.trim()}>
              {create.isPending ? 'Creating…' : 'Create key'}
            </Button>
          </div>
        </form>
        {made && (
          <div className="grid gap-2">
            <p className="text-sm text-foreground">
              Copy the key for {made.name} now. It is shown only once; if you lose it, delete it and create another.
            </p>
            <div className="flex flex-wrap gap-3">
              <Input readOnly aria-label="New API key" value={made.key} className="min-w-60 flex-1 font-mono" />
              <CopyButton text={made.key} label="Copy the API key" />
            </div>
          </div>
        )}
        <Failure error={create.error} />
        {!!keys?.length && (
          <ul className="grid divide-y">
            {keys.map(key => (
              <li key={key.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{key.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {key.start ? `${key.start}… · ` : ''}
                    {key.lastRequest ? `last used ${day.format(new Date(key.lastRequest))}` : 'never used'}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    remove.reset();
                    setDeleting(key);
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
              Servers using this key are refused from their next request. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Failure error={remove.error} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Keep it</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => deleting && remove.mutate({ keyId: deleting.id })}
            >
              {remove.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
