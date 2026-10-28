import type { ComputerView } from './api';

// Display helpers for the computer's state, shared by the sidebar, the overview, and the Computer page.

export const resetsOn = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

// How much of the credit is used, as a percentage for its bar.
export const usedShare = ({ usedShare }: NonNullable<ComputerView['usage']>) => Math.min(100, usedShare * 100);

const count = (n: number, one: string) => `${n.toLocaleString()} ${one}${n === 1 ? '' : 's'}`;
// The billing period's use, such as "42 computer minutes · 318 MCP calls since Oct 1".
export const periodUse = ({ period }: ComputerView) =>
  `${count(period.minutes, 'computer minute')} · ${count(period.mcpCalls, 'MCP call')} since ${resetsOn(period.start)}`;

// What the computer is doing, for the sidebar, the overview, and the Computer page.
export function computerStatus(view: ComputerView) {
  const { computer } = view;
  if (!computer)
    return { short: 'Not started', note: 'It starts the first time an agent opens it.', dot: 'bg-muted-foreground' };
  if (computer.inLiveView)
    return {
      short: 'In live view',
      note: "You're in control. Agents keep working on their own computers.",
      dot: 'bg-brand',
    };
  if (computer.busy)
    return { short: 'In use', note: 'An agent is working on a copy of your computer right now.', dot: 'bg-brand' };
  if (computer.status === 'ready') return { short: 'Ready', note: periodUse(view), dot: 'bg-foreground' };
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
