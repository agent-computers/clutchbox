'use client';
import { Alert, AlertDescription } from '@agent-computers/ui/components/alert';
import { Button } from '@agent-computers/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@agent-computers/ui/components/card';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, browsersQuery, computerQuery, setupQuery, syncQuery } from '../lib/api';

// Always offered, with or without a computer: it also deletes synced data and resets setup.
export function DeleteEverything() {
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const remove = useMutation({
    mutationFn: () => api('/computer', 'DELETE'),
    onSuccess: () => {
      setConfirm(false);
      return Promise.all(
        [computerQuery, setupQuery, syncQuery, browsersQuery].map(query =>
          queryClient.invalidateQueries({ queryKey: query.queryKey }),
        ),
      );
    },
  });
  return (
    <Card id="delete" className="scroll-mt-6">
      <CardHeader>
        <CardTitle>
          <h2>Delete everything</h2>
        </CardTitle>
        <CardDescription>Delete your agent computer and your synced browser data.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {confirm ? (
          <div className="grid gap-3 rounded-lg bg-muted p-4">
            <p className="text-sm">
              This deletes everything: your agent computer, its files, every sign-in on it, and your synced browser
              data. Every browser disconnects and browser sync turns off; connect again from the extension. Agents stay
              connected and get a fresh computer next time. You'll be set up again the next time an agent opens your
              computer.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
                {remove.isPending ? 'Deleting…' : 'Delete everything'}
              </Button>
              <Button variant="secondary" disabled={remove.isPending} onClick={() => setConfirm(false)}>
                Keep it
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <Button
              variant="destructive"
              onClick={() => {
                remove.reset();
                setConfirm(true);
              }}
            >
              Delete everything…
            </Button>
          </div>
        )}
        {remove.isError && (
          <Alert variant="destructive">
            <AlertDescription>{remove.error.message}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
