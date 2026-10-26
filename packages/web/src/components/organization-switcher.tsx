'use client';
import { buttonVariants } from '@agent-computers/ui/components/button';
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
import { Spinner } from '@agent-computers/ui/components/spinner';
import { cn } from '@agent-computers/ui/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronsUpDown, Plus } from 'lucide-react';
import { authResult, organizationsQuery } from '../lib/api';
import { authClient } from '../lib/auth-client';

// Switches the organization the app acts in. Every page's data is that organization's, so a switch refetches it all.
// Shown only to someone in several organizations, or who can create one.
export function OrganizationSwitcher({ onCreate }: { onCreate: () => void }) {
  const queryClient = useQueryClient();
  const { data } = useQuery(organizationsQuery);
  const change = useMutation({
    mutationFn: (organizationId: string) => authResult(authClient.organization.setActive({ organizationId })),
    onSettled: () => queryClient.invalidateQueries(),
  });
  const current = data?.organizations.find(organization => organization.current);
  if (!data || !current || (data.organizations.length < 2 && !data.canCreate)) return null;
  return (
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
            onValueChange={id => id !== current.id && change.mutate(id as string)}
          >
            {data.organizations.map(organization => (
              <DropdownMenuRadioItem closeOnClick key={organization.id} value={organization.id} className="min-h-11">
                <span className="truncate">{organization.name}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        {data.canCreate && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="min-h-11" onClick={onCreate}>
              <Plus aria-hidden />
              New organization
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
