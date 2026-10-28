'use client';
import type { SignInMethods as Methods } from '@clutchbox/server/config';
import { Alert, AlertDescription } from '@clutchbox/ui/components/alert';
import { Button } from '@clutchbox/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@clutchbox/ui/components/card';
import { LogOut } from 'lucide-react';
import { AppPage, useAppUser } from './app-shell';
import { SignInMethods } from './auth/sign-in-methods';
import { useAppSignOut } from './auth/user-button';
import { UserView } from './auth/user-view';
import { DeleteEverything } from './delete-everything';

// The Settings page: who is signed in, sign-out, sign-in methods, and Delete everything. `error` is why connecting a
// sign-in method failed, from Better Auth.
export function Settings({ methods, error }: { methods: Methods; error: string | undefined }) {
  const user = useAppUser();
  const signOut = useAppSignOut();
  const pending = signOut.isPending || signOut.isSuccess;
  return (
    <AppPage title="Settings">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Account</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <UserView user={user} />
            <Button variant="secondary" disabled={pending} onClick={() => signOut.mutate()}>
              <LogOut aria-hidden />
              Sign out
            </Button>
          </div>
          {signOut.isError && (
            <Alert variant="destructive">
              <AlertDescription>Sign-out did not finish. Please try again.</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
      <SignInMethods methods={methods} email={user.email} error={error} />
      <DeleteEverything />
    </AppPage>
  );
}
