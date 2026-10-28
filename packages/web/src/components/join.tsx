'use client';
import { useAcceptInvitation, useInvitation, useRejectInvitation } from '@better-auth-ui/react/plugins/organization';
import { Alert, AlertDescription } from '@clutchbox/ui/components/alert';
import { Button, buttonVariants } from '@clutchbox/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@clutchbox/ui/components/card';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ApiError, api, joinableQuery, type Role } from '../lib/api';
import { authClient } from '../lib/auth-client';
import { Failure } from './failure';

export const roleNames: Record<Role, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };
export const aRole: Record<Role, string> = { owner: 'an owner', admin: 'an admin', member: 'a member' };

// What joining lets the organization do with your sign-ins. Joining is the consent, so every way in shows it.
export function JoinDisclosure({ organization }: { organization: string }) {
  return (
    <p className="text-sm text-foreground">
      Owners and admins of {organization} can create API keys that let their agents use the sites you sync to it. Join
      only an organization you trust with those sign-ins. You choose which sites to sync, and leaving deletes everything
      you had there.
    </p>
  );
}

const joinFailure = (error: Error) =>
  error instanceof ApiError && error.code === 'already_member'
    ? 'You are already a member of this organization.'
    : error instanceof ApiError && error.code === 'not_found'
      ? 'This organization no longer lets your email address join.'
      : 'Joining did not finish. Please try again.';

// Joins, then opens the app.
function useJoin(join: () => Promise<unknown>) {
  const router = useRouter();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: join,
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      router.push('/app');
    },
  });
}

// /join/<invitation>: an invitation, for the person signed in with its address to accept or decline. Adapted from
// Better Auth UI v1.7.30's AcceptInvitation to our shared controls, our disclosure, and inline errors. MIT license:
// auth/LICENSE.
export function AcceptInvitation({ id, email }: { id: string; email: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  // Better Auth shows an invitation only to an account with its address, while it is pending and unexpired.
  const { data: invitation, isPending } = useInvitation(authClient, { query: { id }, retry: false });
  // The app's data is the new organization's from here; marked stale, it refetches in the app rather than here, where
  // the invitation is no longer pending.
  const done = () => {
    void queryClient.invalidateQueries({ refetchType: 'none' });
    router.push('/app');
  };
  const accept = useAcceptInvitation(authClient, { onSuccess: done });
  const decline = useRejectInvitation(authClient, { onSuccess: done });
  const busy = accept.isPending || accept.isSuccess || decline.isPending || decline.isSuccess;
  if (isPending)
    return (
      <Card className="w-full" aria-busy>
        <CardHeader>
          <CardTitle className="text-3xl">
            <h1>Invitation</h1>
          </CardTitle>
          <CardDescription>Signed in as {email}.</CardDescription>
        </CardHeader>
      </Card>
    );
  if (!invitation)
    return (
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="text-3xl">
            <h1>Invitation not found</h1>
          </CardTitle>
          <CardDescription>
            This invitation is not for {email}, has expired, or was cancelled. Sign in with the address it was sent to,
            or ask for a new one.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  const organization = invitation.organizationName;
  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-3xl">
          <h1>Join {organization}</h1>
        </CardTitle>
        <CardDescription>
          You were invited as {aRole[invitation.role as Role]}. Signed in as {email}.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <JoinDisclosure organization={organization} />
        <div className="flex flex-wrap gap-3">
          <Button size="lg" disabled={busy} onClick={() => accept.mutate({ invitationId: id })}>
            {accept.isPending ? 'Joining…' : `Join ${organization}`}
          </Button>
          <Button size="lg" variant="secondary" disabled={busy} onClick={() => decline.mutate({ invitationId: id })}>
            {decline.isPending ? 'Declining…' : 'Decline'}
          </Button>
        </div>
        <Failure error={accept.error ?? decline.error} />
      </CardContent>
    </Card>
  );
}

function JoinByDomain({ organization }: { organization: { id: string; name: string } }) {
  const join = useJoin(() => api('/organizations/join', 'POST', { organizationId: organization.id }));
  return (
    <li className="grid gap-3 rounded-lg border p-4">
      <p className="font-medium">{organization.name}</p>
      <JoinDisclosure organization={organization.name} />
      <div>
        <Button disabled={join.isPending || join.isSuccess} onClick={() => join.mutate()}>
          {join.isPending ? 'Joining…' : `Join ${organization.name}`}
        </Button>
      </div>
      {join.isError && (
        <Alert variant="destructive">
          <AlertDescription>{joinFailure(join.error)}</AlertDescription>
        </Alert>
      )}
    </li>
  );
}

// The organizations that allow your email address's domain, each with its disclosure; nothing when there are none.
export function JoinableOrganizations() {
  const { data } = useQuery(joinableQuery);
  if (!data?.length) return null;
  return (
    <ul className="grid gap-3">
      {data.map(organization => (
        <JoinByDomain key={organization.id} organization={organization} />
      ))}
    </ul>
  );
}

// /join: organizations that allow your email address's domain, for someone in none here yet or, from the switcher, in
// one already. Without any, says how to get invited.
export function JoinPage({ email, member }: { email: string; member: boolean }) {
  const { data, isPending, isError } = useQuery(joinableQuery);
  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-3xl">
          <h1>{member ? 'Join another organization' : 'Join an organization'}</h1>
        </CardTitle>
        <CardDescription>
          {isPending || data?.length
            ? `Signed in as ${email}.`
            : member
              ? `No other organization here lets ${email} join. Ask an owner or admin to invite this address, or to allow your email address's domain.`
              : `${email} is not in an organization here yet. Ask an owner or admin of yours to invite this address, or to allow your email address's domain.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <JoinableOrganizations />
        {isError && (
          <Alert variant="destructive">
            <AlertDescription>Organizations could not load. Reload to try again.</AlertDescription>
          </Alert>
        )}
        {member && (
          <div>
            <Link href="/app" className={buttonVariants({ variant: 'secondary' })}>
              Back to the app
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
