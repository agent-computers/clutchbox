'use client';
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
import { Badge } from '@agent-computers/ui/components/badge';
import { Button, buttonVariants } from '@agent-computers/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@agent-computers/ui/components/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@agent-computers/ui/components/dropdown-menu';
import { Input } from '@agent-computers/ui/components/input';
import { Label } from '@agent-computers/ui/components/label';
import { ToggleGroup, ToggleGroupItem } from '@agent-computers/ui/components/toggle-group';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ellipsis } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import {
  type ApiKey,
  api,
  apiKeysQuery,
  type Invitation,
  invitationsQuery,
  joinableQuery,
  type OrganizationView,
  organizationQuery,
  organizationsQuery,
  type Role,
} from '../lib/api';
import { AppPage } from './app-shell';
import { ConnectApps } from './connect-apps';
import { CopyButton } from './copy-button';
import { Failure } from './failure';
import { aRole, JoinableOrganizations, roleNames } from './join';

// Owners manage everyone; admins manage admins and members. Only owners make owners.
const manages = (role: Role) => role === 'owner' || role === 'admin';
const grantable = (actor: Role): Role[] => (actor === 'owner' ? ['owner', 'admin', 'member'] : ['admin', 'member']);
const mayManage = (actor: Role, target: Role) => manages(actor) && (actor === 'owner' || target !== 'owner');
const day = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

// The Organization page: who is in it and their roles, and for owners and admins invitations and join domains;
// for anyone, leaving, and other organizations that allow their email address's domain.
export function Organization() {
  const { data, isError } = useQuery(organizationQuery);
  return (
    <AppPage title="Organization" description={data && `You are ${aRole[data.role]} of ${data.organization.name}.`}>
      {isError && (
        <Alert variant="destructive">
          <AlertDescription>Your organization could not load. Reload to try again.</AlertDescription>
        </Alert>
      )}
      {data && (
        <>
          <Members view={data} />
          {manages(data.role) && <Invitations role={data.role} />}
          {manages(data.role) && <JoinDomains domains={data.organization.joinDomains} />}
          {manages(data.role) && <ApiKeys />}
          {manages(data.role) && <ConnectApps />}
          <OtherOrganizations />
          <NewOrganization />
          <Leave
            name={data.organization.name}
            onlyOwner={data.role === 'owner' && data.members.filter(member => member.role === 'owner').length === 1}
          />
        </>
      )}
    </AppPage>
  );
}

function Members({ view }: { view: OrganizationView }) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: organizationQuery.queryKey });
  const [removing, setRemoving] = useState<OrganizationView['members'][number] | null>(null);
  const changeRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: Role }) => api(`/organization/members/${id}`, 'PATCH', { role }),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/organization/members/${id}`, 'DELETE'),
    onSuccess: () => setRemoving(null),
    onSettled: refresh,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Members</h2>
        </CardTitle>
        <CardDescription>
          Everyone here syncs their own sites and has their own computer. No one can watch another member's computer.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <ul className="grid divide-y">
          {view.members.map(member => (
            <li key={member.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0">
                <p className="truncate font-medium">
                  {member.name}
                  {member.you && <span className="font-normal text-muted-foreground"> (you)</span>}
                </p>
                <p className="truncate text-sm text-muted-foreground">{member.email}</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={member.role === 'member' ? 'outline' : 'secondary'}>{roleNames[member.role]}</Badge>
                {!member.you && mayManage(view.role, member.role) && (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      aria-label={`Manage ${member.name}`}
                      disabled={changeRole.isPending || remove.isPending}
                      className={buttonVariants({ variant: 'ghost', size: 'icon' })}
                    >
                      <Ellipsis aria-hidden />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-44">
                      <DropdownMenuGroup>
                        <DropdownMenuLabel>Role</DropdownMenuLabel>
                        <DropdownMenuRadioGroup
                          value={member.role}
                          onValueChange={role => changeRole.mutate({ id: member.id, role: role as Role })}
                        >
                          {grantable(view.role).map(role => (
                            <DropdownMenuRadioItem closeOnClick key={role} value={role} className="min-h-11">
                              {roleNames[role]}
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                      </DropdownMenuGroup>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        className="min-h-11"
                        onClick={() => {
                          remove.reset();
                          setRemoving(member);
                        }}
                      >
                        Remove…
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            </li>
          ))}
        </ul>
        <Failure error={changeRole.error} />
      </CardContent>
      <AlertDialog open={!!removing} onOpenChange={open => !open && !remove.isPending && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes everything they had in {view.organization.name}: their computer, its files and sign-ins, and
              their synced browser data. Their browsers and agents disconnect from it. Their other organizations are not
              affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Failure error={remove.error} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Keep them</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => removing && remove.mutate(removing.id)}
            >
              {remove.isPending ? 'Removing…' : 'Remove'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function Invitations({ role }: { role: Role }) {
  const queryClient = useQueryClient();
  const { data: invitations } = useQuery(invitationsQuery);
  const [inviteAs, setInviteAs] = useState<Role>('member');
  const refresh = () => queryClient.invalidateQueries({ queryKey: invitationsQuery.queryKey });
  const create = useMutation({
    mutationFn: () =>
      api<{ invitation: Invitation & { url: string } }>('/organization/invitations', 'POST', { role: inviteAs }),
    onSettled: refresh,
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/organization/invitations/${id}`, 'DELETE'),
    onSettled: refresh,
  });
  const link = create.data?.invitation;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Invite by link</h2>
        </CardTitle>
        <CardDescription>Each link lets one person join, with the role you choose, within 7 days.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <ToggleGroup
            aria-label="Role"
            variant="outline"
            spacing={0}
            value={[inviteAs]}
            onValueChange={([next]) => next && setInviteAs(next as Role)}
          >
            {[...grantable(role)].reverse().map(each => (
              <ToggleGroupItem key={each} value={each}>
                {roleNames[each]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Button disabled={create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? 'Creating…' : 'Create invitation link'}
          </Button>
        </div>
        {link && (
          <div className="grid gap-2">
            <p className="text-sm text-soft">
              Send this {roleNames[link.role].toLowerCase()} invitation to one person. It is shown only now.
            </p>
            <div className="flex flex-wrap gap-3">
              <Input readOnly aria-label="Invitation link" value={link.url} className="min-w-60 flex-1" />
              <CopyButton text={link.url} label="Copy the invitation link" />
            </div>
          </div>
        )}
        <Failure error={create.error} />
        {!!invitations?.length && (
          <div className="grid gap-2">
            <h3 className="text-sm font-medium">Waiting to be used</h3>
            <ul className="grid divide-y">
              {invitations.map(invitation => (
                <li key={invitation.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                  <p className="text-sm">
                    {roleNames[invitation.role]}
                    <span className="text-muted-foreground">
                      {invitation.invitedBy && ` · from ${invitation.invitedBy}`} · until{' '}
                      {day.format(new Date(invitation.expiresAt))}
                    </span>
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={revoke.isPending && revoke.variables === invitation.id}
                    onClick={() => revoke.mutate(invitation.id)}
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <Failure error={revoke.error} />
      </CardContent>
    </Card>
  );
}

function JoinDomains({ domains }: { domains: string[] }) {
  const queryClient = useQueryClient();
  const fieldId = useId();
  const [text, setText] = useState(domains.join(', '));
  const save = useMutation({
    mutationFn: () =>
      api('/organization/join-domains', 'PUT', {
        domains: text.split(/[\s,]+/).filter(Boolean),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: organizationQuery.queryKey }),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Join by email domain</h2>
        </CardTitle>
        <CardDescription>
          People signed in with an address at these domains can join as members without a link.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-3"
          onSubmit={event => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <Label htmlFor={fieldId}>Domains</Label>
          <div className="flex flex-wrap gap-3">
            <Input
              id={fieldId}
              placeholder="acme.com"
              value={text}
              onChange={event => {
                save.reset();
                setText(event.target.value);
              }}
              className="min-w-60 flex-1"
            />
            <Button type="submit" variant="secondary" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : save.isSuccess ? 'Saved' : 'Save'}
            </Button>
          </div>
          <Failure error={save.error} />
        </form>
      </CardContent>
    </Card>
  );
}

// Keys for the organization's developers' servers, which read every member's latest capture over REST. The secret is
// shown once, right after creating it.
function ApiKeys() {
  const queryClient = useQueryClient();
  const { data: keys } = useQuery(apiKeysQuery);
  const fieldId = useId();
  const [name, setName] = useState('');
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: apiKeysQuery.queryKey });
  const create = useMutation({
    mutationFn: () =>
      api<{ key: { id: string; name: string; secret: string } }>('/organization/api-keys', 'POST', {
        name,
        scopes: ['captures'],
      }),
    onSuccess: () => setName(''),
    onSettled: refresh,
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/organization/api-keys/${id}`, 'DELETE'),
    onSuccess: () => setRevoking(null),
    onSettled: refresh,
  });
  const made = create.data?.key;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>API keys</h2>
        </CardTitle>
        <CardDescription>
          A key lets your servers read any member's latest synced sign-ins over the REST API, to use in your own
          browsers. Members agreed to this when they joined. Keep keys secret, and revoke one you no longer use.
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
            <p className="text-sm text-soft">
              Copy the key for {made.name} now. It is shown only once; if you lose it, revoke it and create another.
            </p>
            <div className="flex flex-wrap gap-3">
              <Input readOnly aria-label="New API key" value={made.secret} className="min-w-60 flex-1 font-mono" />
              <CopyButton text={made.secret} label="Copy the API key" />
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
                    {key.createdBy ? `From ${key.createdBy} · ` : ''}
                    {key.lastUsedAt ? `last used ${day.format(new Date(key.lastUsedAt))}` : 'never used'}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    revoke.reset();
                    setRevoking(key);
                  }}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <AlertDialog open={!!revoking} onOpenChange={open => !open && !revoke.isPending && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {revoking?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Servers using this key are refused from their next request. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Failure error={revoke.error} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoke.isPending}>Keep it</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={revoke.isPending}
              onClick={() => revoking && revoke.mutate(revoking.id)}
            >
              {revoke.isPending ? 'Revoking…' : 'Revoke'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function OtherOrganizations() {
  const { data } = useQuery(joinableQuery);
  if (!data?.length) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Organizations you can join</h2>
        </CardTitle>
        <CardDescription>They let people at your email address's domain join.</CardDescription>
      </CardHeader>
      <CardContent>
        <JoinableOrganizations />
      </CardContent>
    </Card>
  );
}

// Offered only where the deployment lets people create organizations. The new one is where the person acts next.
function NewOrganization() {
  const queryClient = useQueryClient();
  const { data } = useQuery(organizationsQuery);
  const fieldId = useId();
  const field = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => api<{ organization: { id: string; name: string } }>('/organizations', 'POST', { name }),
    onSuccess: async () => {
      setName('');
      await queryClient.invalidateQueries();
      window.scrollTo({ top: 0 });
    },
  });
  // The switcher's New organization comes here.
  const canCreate = !!data?.canCreate;
  useEffect(() => {
    if (canCreate && window.location.hash === '#new') {
      field.current?.scrollIntoView({ block: 'center' });
      field.current?.focus();
    }
  }, [canCreate]);
  if (!canCreate) return null;
  return (
    <Card id="new" className="scroll-mt-6">
      <CardHeader>
        <CardTitle>
          <h2>New organization</h2>
        </CardTitle>
        <CardDescription>
          For a team or an app of yours. You own it, invite others to it, and switch to it from the menu at the top.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-3"
          onSubmit={event => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <Label htmlFor={fieldId}>Name</Label>
          <div className="flex flex-wrap gap-3">
            <Input
              id={fieldId}
              ref={field}
              required
              maxLength={100}
              value={name}
              onChange={event => setName(event.target.value)}
              className="min-w-60 flex-1"
            />
            <Button type="submit" disabled={create.isPending || !name.trim()}>
              {create.isPending ? 'Creating…' : 'Create organization'}
            </Button>
          </div>
          <Failure error={create.error} />
        </form>
      </CardContent>
    </Card>
  );
}

function Leave({ name, onlyOwner }: { name: string; onlyOwner: boolean }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const leave = useMutation({
    mutationFn: () => api('/organization/leave', 'POST'),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      router.push('/app');
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Leave {name}</h2>
        </CardTitle>
        <CardDescription>
          {onlyOwner
            ? 'You are its only owner. To leave, make someone else an owner first.'
            : 'Leaving deletes everything you had here.'}
        </CardDescription>
      </CardHeader>
      {!onlyOwner && (
        <CardContent className="grid gap-4">
          {confirm ? (
            <div className="grid gap-3 rounded-lg bg-muted p-4">
              <p className="text-sm">
                This deletes your computer in {name}, its files and sign-ins, and the browser data you synced to it.
                Your browsers and agents disconnect from it. To come back, you need a new invitation, or an address at a
                domain it allows.
              </p>
              <div className="flex flex-wrap gap-3">
                <Button variant="destructive" disabled={leave.isPending} onClick={() => leave.mutate()}>
                  {leave.isPending ? 'Leaving…' : `Leave ${name}`}
                </Button>
                <Button variant="secondary" disabled={leave.isPending} onClick={() => setConfirm(false)}>
                  Stay
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <Button
                variant="destructive"
                onClick={() => {
                  leave.reset();
                  setConfirm(true);
                }}
              >
                Leave…
              </Button>
            </div>
          )}
          <Failure error={leave.error} />
        </CardContent>
      )}
    </Card>
  );
}
