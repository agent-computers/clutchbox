import type { ComputerView } from './api';

// Display helpers for the computer's state, shared by the sidebar, the overview, and the Computer page.

export const resetsOn = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

// What the computer is doing, for the sidebar, the overview, and the Computer page.
export function computerStatus({ computer }: ComputerView) {
  if (!computer)
    return { short: 'Not started', note: 'It starts the first time an agent opens it.', dot: 'bg-muted-foreground' };
  if (computer.inLiveView)
    return { short: 'In live view', note: "You're in control. Agents wait until you hand back.", dot: 'bg-primary' };
  if (computer.busy) return { short: 'In use', note: 'An agent is using your computer right now.', dot: 'bg-soft' };
  if (computer.status === 'ready')
    return { short: 'Ready', note: 'Your agents open it when they need it.', dot: 'bg-foreground' };
  return { short: 'Starting', note: 'Your computer is starting.', dot: 'bg-muted-foreground' };
}

// When synced sign-ins were copied, and whether the computer has that copy yet.
export function syncedSignIns({ capture, computer }: ComputerView) {
  if (!capture) return null;
  const applied = computer?.appliedCaptureAt;
  return {
    copiedAt: capture.completedAt,
    applied: !!applied && Date.parse(applied) >= Date.parse(capture.completedAt),
  };
}
