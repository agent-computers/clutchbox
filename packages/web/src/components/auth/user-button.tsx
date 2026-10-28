'use client';
import { useAuth, useSignOut } from '@better-auth-ui/react';
// Better Auth UI v1.7.30 UserButton, adapted to our settings route and immediate sign-out. MIT license: LICENSE.
import { Alert, AlertDescription } from '@clutchbox/ui/components/alert';
import { buttonVariants } from '@clutchbox/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@clutchbox/ui/components/dropdown-menu';
import { Spinner } from '@clutchbox/ui/components/spinner';
import { cn } from '@clutchbox/ui/lib/utils';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronsUpDown, LogOut, Settings } from 'lucide-react';
import type { UserIdentity } from './user-avatar';
import { UserView } from './user-view';

// Signs out, clears account-specific caches, and goes to sign-in, which returns to `next` (a path it accepts).
export function useAppSignOut(next?: string) {
  const { authClient, basePaths, viewPaths } = useAuth();
  const queryClient = useQueryClient();
  return useSignOut(authClient, {
    onSuccess: () => {
      // Product queries contain account-specific data too; a full navigation also drops Next's route cache.
      queryClient.clear();
      const signIn = `${basePaths.auth}/${viewPaths.auth.signIn}`;
      window.location.assign(next ? `${signIn}?${new URLSearchParams({ next })}` : signIn);
    },
  });
}

export function UserButton({ user }: { user: UserIdentity }) {
  const { basePaths, viewPaths, navigate, localization } = useAuth();
  const signOut = useAppSignOut();
  const pending = signOut.isPending || signOut.isSuccess;
  return (
    <div className="grid max-w-full gap-3">
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Account menu"
          disabled={pending}
          className={cn(buttonVariants({ variant: 'secondary', size: 'lg' }), 'h-auto max-w-full py-2.5 font-normal')}
        >
          <UserView user={user} hideSubtitle />
          {pending ? <Spinner /> : <ChevronsUpDown aria-hidden="true" className="ml-auto size-4" />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56 max-w-[calc(100vw-2rem)]">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="p-3 font-normal">
              <UserView user={user} />
            </DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="min-h-11"
            onClick={() => navigate({ to: `${basePaths.settings}/${viewPaths.settings.account}` })}
          >
            <Settings aria-hidden="true" />
            Settings
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="min-h-11" disabled={pending} onClick={() => signOut.mutate()}>
            <LogOut aria-hidden="true" />
            {localization.auth.signOut}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {signOut.isError && (
        <Alert variant="destructive">
          <AlertDescription>Sign-out did not finish. Please try again.</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
