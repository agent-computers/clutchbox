'use client';
import { Button } from '@clutchbox/ui/components/button';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { api, setupQuery } from '../lib/api';

// Shown once, when an agent first opens the computer; closing it is stored on the server.
export function SetupNotice() {
  const queryClient = useQueryClient();
  const close = useMutation({
    mutationFn: () => api('/setup/notice/close', 'POST'),
    onSettled: () => queryClient.invalidateQueries({ queryKey: setupQuery.queryKey }),
  });
  // Hide at once; if closing fails, the notice comes back.
  if (close.isPending || close.isSuccess) return null;
  return (
    <div
      role="status"
      className="flex items-center justify-between gap-4 rounded-xl bg-card py-2 pr-2 pl-4 ring-1 ring-foreground/10"
    >
      <p>You're set up. Your agents can use your computer.</p>
      <Button variant="ghost" className="size-11 px-0" aria-label="Close" onClick={() => close.mutate()}>
        <X aria-hidden />
      </Button>
    </div>
  );
}
