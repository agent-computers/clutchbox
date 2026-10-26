'use client';
import { Alert, AlertDescription } from '@agent-computers/ui/components/alert';
import { Button } from '@agent-computers/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@agent-computers/ui/components/card';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { ApiError, api, authResult, joinableQuery, type Role } from '../lib/api';
import { authClient } from '../lib/auth-client';

export const roleNames: Record<Role, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };
export const aRole: Record<Role, string> = { owner: 'an owner', admin: 'an admin', member: 'a member' };

// What joining lets the organization do with your sign-ins. Joining is the consent, so every way in shows it.
export function JoinDisclosure({ organization }: { organization: string }) {
  return (
    <p className="text-sm text-soft">
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

// /join/<invitation>: an invitation, for the person signed in with its address to accept.
export function AcceptInvitation({
  id,
  email,
  invitation,
}: {
  id: string;
  email: string;
  invitation: { organization: string; role: Role } | null;
}) {
  const join = useJoin(() => authResult(authClient.organization.acceptInvitation({ invitationId: id })));
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
  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-3xl">
          <h1>Join {invitation.organization}</h1>
        </CardTitle>
        <CardDescription>You were invited as {aRole[invitation.role]}.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <JoinDisclosure organization={invitation.organization} />
        <div>
          <Button size="lg" disabled={join.isPending || join.isSuccess} onClick={() => join.mutate()}>
            {join.isPending ? 'Joining…' : `Join ${invitation.organization}`}
          </Button>
        </div>
        {join.isError && (
          <Alert variant="destructive">
            <AlertDescription>{join.error.message}</AlertDescription>
          </Alert>
        )}
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

// /join: signed in but in no organization here. Offers those that allow your domain, or says how to get invited.
export function JoinPage({ email }: { email: string }) {
  const { data, isPending, isError } = useQuery(joinableQuery);
  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-3xl">
          <h1>Join an organization</h1>
        </CardTitle>
        <CardDescription>
          {isPending || data?.length
            ? `Signed in as ${email}.`
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
      </CardContent>
    </Card>
  );
}
