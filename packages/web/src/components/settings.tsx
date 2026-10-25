'use client';
import { Alert, AlertDescription } from '@agent-computers/ui/components/alert';
import { Button } from '@agent-computers/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@agent-computers/ui/components/card';
import { LogOut } from 'lucide-react';
import { AppPage, useAppUser } from './app-shell';
import { useAppSignOut } from './auth/user-button';
import { UserView } from './auth/user-view';
import { DeleteEverything } from './delete-everything';

// The Settings page: who is signed in, sign-out, and Delete everything.
export function Settings() {
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
      <DeleteEverything />
    </AppPage>
  );
}
