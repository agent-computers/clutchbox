'use client';
// The members and invitations parts adapt Better Auth UI v1.7.30's OrganizationMembers, OrganizationInvitations, and
// InviteMemberDialog to our shared controls and inline errors, on its hooks. MIT license: auth/LICENSE.
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
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@agent-computers/ui/components/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@agent-computers/ui/components/dialog';
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
import { useSession } from '@better-auth-ui/react';
import {
  useCancelInvitation,
  useInviteMember,
  useListOrganizationInvitations,
  useListOrganizationMembers,
  useUpdateMemberRole,
} from '@better-auth-ui/react/plugins/organization';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ellipsis } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { api, organizationQuery, type Role } from '../lib/api';
import { authClient } from '../lib/auth-client';
import { AppPage } from './app-shell';
import { CopyButton } from './copy-button';
import { Failure } from './failure';
import { aRole, roleNames } from './join';

// Owners manage everyone; admins manage admins and members. Only owners make owners. The server holds the same rules
// (organization-auth.ts); these only decide what to offer.
export const manages = (role: Role) => role === 'owner' || role === 'admin';
const grantable = (actor: Role): Role[] => (actor === 'owner' ? ['owner', 'admin', 'member'] : ['admin', 'member']);
const mayManage = (actor: Role, target: Role) => manages(actor) && (actor === 'owner' || target !== 'owner');
export const day = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const linkOf = (id: string) => `${window.location.origin}/join/${id}`;

// The organization's members, oldest first, from Better Auth.
function useMembers(organizationId: string | undefined) {
  const { data } = useListOrganizationMembers(authClient, {
    query: { organizationId, sortBy: 'createdAt', sortDirection: 'asc' },
  });
  return data?.members;
}

// The Organization page: who is in it, with their roles and, for owners and admins, the invitations still waiting;
// for owners and admins, inviting and join domains; and for anyone, leaving. Creating and joining other organizations
// is in the switcher, and API keys and Connect apps are on the Developers page.
export function Organization() {
  const { data, isError } = useQuery(organizationQuery);
  const members = useMembers(data?.organization.id);
  return (
    <AppPage title="Organization" description={data && `You are ${aRole[data.role]} of ${data.organization.name}.`}>
      {isError && (
        <Alert variant="destructive">
          <AlertDescription>Your organization could not load. Reload to try again.</AlertDescription>
        </Alert>
      )}
      {data && (
        <>
          <Members organization={data.organization} role={data.role} />
          {manages(data.role) && <JoinDomains domains={data.organization.joinDomains} />}
          <Leave
            name={data.organization.name}
            onlyOwner={data.role === 'owner' && members?.filter(member => member.role === 'owner').length === 1}
          />
        </>
      )}
    </AppPage>
  );
}

type MemberRow = NonNullable<ReturnType<typeof useMembers>>[number];

// Everyone in the organization, then, for owners and admins, the invitations still waiting: each names one email
// address, which only an account with that address can accept. They are emailed when the server sends email; the
// link works either way.
function Members({ organization, role }: { organization: { id: string; name: string }; role: Role }) {
  const queryClient = useQueryClient();
  const members = useMembers(organization.id);
  const { data: invitations } = useListOrganizationInvitations(authClient, {
    query: { organizationId: organization.id },
    enabled: manages(role),
  });
  const waiting = invitations?.filter(
    invitation => invitation.status === 'pending' && new Date(invitation.expiresAt) > new Date(),
  );
  const { data: session } = useSession(authClient);
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<MemberRow | null>(null);
  const changeRole = useUpdateMemberRole(authClient);
  const cancel = useCancelInvitation(authClient);
  // Removing deletes the member's computer and grants too, which Better Auth's remove-member doesn't, so it is ours
  // (members.ts).
  const remove = useMutation({
    mutationFn: (id: string) => api(`/organization/members/${id}`, 'DELETE'),
    onSuccess: () => setRemoving(null),
    onSettled: () => queryClient.invalidateQueries(),
  });
  const row = 'flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0';
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Members</h2>
        </CardTitle>
        <CardDescription>
          Everyone here syncs their own sites and has their own computer. No one can watch another member's computer.
        </CardDescription>
        {manages(role) && (
          <CardAction>
            <Button onClick={() => setInviting(true)}>Invite</Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="grid gap-4">
        <ul className="grid divide-y">
          {members?.map(member => {
            const you = member.userId === session?.user.id;
            const memberRole = member.role as Role;
            return (
              <li key={member.id} className={row}>
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {member.user.name}
                    {you && <span className="font-normal text-muted-foreground"> (you)</span>}
                  </p>
                  <p className="truncate text-sm text-muted-foreground">{member.user.email}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={memberRole === 'member' ? 'outline' : 'secondary'}>{roleNames[memberRole]}</Badge>
                  {!you && mayManage(role, memberRole) && (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        aria-label={`Manage ${member.user.name}`}
                        disabled={changeRole.isPending || remove.isPending}
                        className={buttonVariants({ variant: 'ghost', size: 'icon' })}
                      >
                        <Ellipsis aria-hidden />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-44">
                        <DropdownMenuGroup>
                          <DropdownMenuLabel>Role</DropdownMenuLabel>
                          <DropdownMenuRadioGroup
                            value={memberRole}
                            onValueChange={next =>
                              changeRole.mutate({
                                memberId: member.id,
                                role: next as Role,
                                organizationId: organization.id,
                              })
                            }
                          >
                            {grantable(role).map(each => (
                              <DropdownMenuRadioItem closeOnClick key={each} value={each} className="min-h-11">
                                {roleNames[each]}
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
            );
          })}
          {waiting?.map(invitation => (
            <li key={invitation.id} className={row}>
              <div className="min-w-0">
                <p className="truncate font-medium">{invitation.email}</p>
                <p className="truncate text-sm text-muted-foreground">
                  Invited as {aRole[invitation.role as Role]} · until {day.format(new Date(invitation.expiresAt))}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <Badge variant="outline">Invited</Badge>
                <CopyButton text={linkOf(invitation.id)} label={`Copy the invitation link for ${invitation.email}`} />
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={cancel.isPending && cancel.variables?.invitationId === invitation.id}
                  onClick={() => cancel.mutate({ invitationId: invitation.id })}
                >
                  Cancel
                </Button>
              </div>
            </li>
          ))}
        </ul>
        <Failure error={changeRole.error ?? cancel.error} />
      </CardContent>
      {manages(role) && (
        <Invite organizationId={organization.id} role={role} open={inviting} onOpenChange={setInviting} />
      )}
      <AlertDialog open={!!removing} onOpenChange={open => !open && !remove.isPending && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.user.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes everything they had in {organization.name}: their computer, its files and sign-ins, and their
              synced browser data. Their browsers and agents disconnect from it. Their other organizations are not
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

// Invites one email address with a role, then shows the invitation's link for when no email arrives.
function Invite({
  organizationId,
  role,
  open,
  onOpenChange,
}: {
  organizationId: string;
  role: Role;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const fieldId = useId();
  const [email, setEmail] = useState('');
  const [inviteAs, setInviteAs] = useState<Role>('member');
  const create = useInviteMember(authClient, { onSuccess: () => setEmail('') });
  const sent = create.data;
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next) create.reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite</DialogTitle>
          <DialogDescription>Only someone signed in with this email address can join, within 7 days.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={event => {
            event.preventDefault();
            create.mutate({ email: email.trim(), role: inviteAs, organizationId });
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor={fieldId}>Email address</Label>
            <Input
              id={fieldId}
              type="email"
              required
              placeholder="name@example.com"
              value={email}
              onChange={event => setEmail(event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <p className="text-sm leading-none font-medium select-none">Role</p>
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
          </div>
          {sent && (
            <div className="grid gap-2">
              <p className="text-sm text-foreground">
                Invited {sent.email}. If they don't get an email, send them this link.
              </p>
              <div className="flex gap-2">
                <Input readOnly aria-label="Invitation link" value={linkOf(sent.id)} className="min-w-0 flex-1" />
                <CopyButton text={linkOf(sent.id)} label="Copy the invitation link" />
              </div>
            </div>
          )}
          <Failure error={create.error} />
          <DialogFooter>
            <Button type="submit" disabled={create.isPending || !email.trim()}>
              {create.isPending ? 'Inviting…' : sent ? 'Invite another' : 'Invite'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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

// Leaving deletes the member's computer and grants too, which Better Auth's leave doesn't, so it is ours (members.ts).
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
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          <h2 className="font-sans text-base font-medium">Leave {name}</h2>
        </CardTitle>
        <CardDescription>
          {onlyOwner
            ? 'You are its only owner. To leave, make someone else an owner first.'
            : 'Deletes your computer and the browser data you synced here.'}
        </CardDescription>
        {!onlyOwner && (
          <CardAction>
            <Button
              variant="outline"
              className="text-destructive"
              onClick={() => {
                leave.reset();
                setConfirm(true);
              }}
            >
              Leave…
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <AlertDialog open={confirm} onOpenChange={open => !open && !leave.isPending && setConfirm(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes your computer in {name}, its files and sign-ins, and the browser data you synced to it. Your
              browsers and agents disconnect from it. To come back, you need a new invitation, or an address at a domain
              it allows.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Failure error={leave.error} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={leave.isPending}>Stay</AlertDialogCancel>
            <Button variant="destructive" disabled={leave.isPending} onClick={() => leave.mutate()}>
              {leave.isPending ? 'Leaving…' : 'Leave'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
