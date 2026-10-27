'use client';
// Creating an organization adapts Better Auth UI v1.7.30's CreateOrganizationDialog to our shared controls and inline
// errors, on its hook. MIT license: auth/LICENSE.
import { Button, buttonVariants } from '@agent-computers/ui/components/button';
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
import { Spinner } from '@agent-computers/ui/components/spinner';
import { cn } from '@agent-computers/ui/lib/utils';
import { useCreateOrganization, useSetActiveOrganization } from '@better-auth-ui/react/plugins/organization';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronsUpDown, LogIn, Plus } from 'lucide-react';
import { useId, useState } from 'react';
import { joinableQuery, organizationsQuery } from '../lib/api';
import { authClient } from '../lib/auth-client';
import { Failure } from './failure';

// Switches the organization the app acts in, creates one, and leads to those that allow your email address's domain.
// Every page's data is the current organization's, so a switch refetches it all. Shown only when there is something
// to switch to, create, or join. The list is ours rather than Better Auth's, which says neither which organization is
// personal nor whether the deployment lets you create one.
export function OrganizationSwitcher({
  onCreated,
  onJoin,
}: {
  // After creating one, which is then the current organization.
  onCreated: () => void;
  // To the join page, which offers each joinable organization with what joining shares.
  onJoin: () => void;
}) {
  const queryClient = useQueryClient();
  const { data } = useQuery(organizationsQuery);
  const { data: joinable } = useQuery(joinableQuery);
  const [creating, setCreating] = useState(false);
  const change = useSetActiveOrganization(authClient, { onSettled: () => queryClient.invalidateQueries() });
  const current = data?.organizations.find(organization => organization.current);
  if (!data || !current || (data.organizations.length < 2 && !data.canCreate && !joinable?.length)) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Organization: ${current.name}. Switch`}
          disabled={change.isPending}
          className={cn(buttonVariants({ variant: 'secondary' }), 'h-11 w-full justify-between font-normal')}
        >
          <span className="truncate">{current.name}</span>
          {change.isPending ? <Spinner aria-hidden /> : <ChevronsUpDown aria-hidden />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Organizations</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={current.id}
              onValueChange={id => id !== current.id && change.mutate({ organizationId: id as string })}
            >
              {data.organizations.map(organization => (
                <DropdownMenuRadioItem closeOnClick key={organization.id} value={organization.id} className="min-h-11">
                  <span className="truncate">{organization.name}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          {(data.canCreate || !!joinable?.length) && <DropdownMenuSeparator />}
          {data.canCreate && (
            <DropdownMenuItem className="min-h-11" onClick={() => setCreating(true)}>
              <Plus aria-hidden />
              New organization…
            </DropdownMenuItem>
          )}
          {!!joinable?.length && (
            <DropdownMenuItem className="min-h-11" onClick={onJoin}>
              <LogIn aria-hidden />
              Join another organization
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {data.canCreate && <NewOrganization open={creating} onOpenChange={setCreating} onCreated={onCreated} />}
    </>
  );
}

// The new organization is where the person acts next (the server switches to it).
function NewOrganization({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const queryClient = useQueryClient();
  const fieldId = useId();
  const [name, setName] = useState('');
  const create = useCreateOrganization(authClient, {
    onSuccess: async () => {
      setName('');
      onOpenChange(false);
      await queryClient.invalidateQueries();
      onCreated();
    },
  });
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
          <DialogTitle>New organization</DialogTitle>
          <DialogDescription>For a team or an app of yours. You own it and invite others to it.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={event => {
            event.preventDefault();
            // The server sets the slug itself (organization-auth.ts); sending one skips the check for a free one.
            create.mutate({ name: name.trim(), slug: crypto.randomUUID() });
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor={fieldId}>Name</Label>
            <Input id={fieldId} required maxLength={100} value={name} onChange={event => setName(event.target.value)} />
          </div>
          <Failure error={create.error} />
          <DialogFooter>
            <Button type="submit" disabled={create.isPending || !name.trim()}>
              {create.isPending ? 'Creating…' : 'Create organization'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
