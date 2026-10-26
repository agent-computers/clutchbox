import type { StatusResponse, SyncStatus as Sync } from '@agent-computers/capture';
import type { ReactNode } from 'react';
import { Button, buttonVariants } from './components/button';

export const hint = 'text-[13px] leading-relaxed text-muted-foreground';
const when = (iso: string | undefined) => (iso ? new Date(iso).toLocaleString() : 'unknown time');
export function syncMessage(sync: Sync): string {
  const last = sync.uploadedAt ? ` Last upload ${when(sync.uploadedAt)}.` : '';
  switch (sync.state) {
    case 'never':
      return 'Not synced yet.';
    case 'uploading':
      return 'Syncing…';
    case 'synced':
      return `Synced ${when(sync.uploadedAt)}.`;
    case 'unchanged':
      return `Up to date.${last}`;
    case 'unavailable':
      return `Sync is temporarily unavailable and retries in a minute.${last}`;
    case 'failed':
      return `The last upload did not finish and retries in a minute.${last}`;
    case 'delete_failed':
      return 'The uploaded copy could not be confirmed deleted. Use Turn off sync or Delete everything on your account page.';
    case 'too_large':
      return 'This capture is over the 4 MB upload limit. Sync only added sites, or exclude domains, to make it smaller.';
    case 'outdated':
      return 'This version of the extension can no longer sync. Install the update to continue.';
  }
}
// Today's syncs show the time; older ones the date.
function short(iso: string | undefined) {
  if (!iso) return '';
  const date = new Date(iso);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
// The one-line sync status, with a detail and an action only when the user should act.
type Summary = {
  label: string;
  tone: 'ok' | 'idle' | 'problem';
  detail?: string;
  action?: 'account' | 'reconnect';
};
function summarize({ capture, sync, settings, account }: StatusResponse, busy: boolean): Summary {
  if (account.state === 'reconnect')
    return {
      label: 'Reconnect needed',
      tone: 'problem',
      detail: `This browser stopped syncing${account.email ? ` to ${account.email}` : ''}. It was disconnected, unused for 30 days, or updated from an older version. Your sites and exclusions are kept.`,
      action: 'reconnect',
    };
  if (settings.paused) return { label: 'Paused', tone: 'idle', detail: 'Your agents keep the last upload.' };
  if (busy || capture.state === 'capturing' || sync.state === 'uploading') return { label: 'Syncing…', tone: 'idle' };
  if (capture.state === 'interrupted' || capture.state === 'failed')
    return { label: 'Capture failed', tone: 'problem', detail: 'Sync now to retry.' };
  const last = sync.uploadedAt ? ` Last synced ${short(sync.uploadedAt)}.` : '';
  switch (sync.state) {
    case 'synced':
      return { label: `Synced ${short(sync.uploadedAt)}`, tone: 'ok' };
    case 'unchanged':
      return { label: 'Up to date', tone: 'ok' };
    case 'delete_failed':
      return { label: 'Deletion not confirmed', tone: 'problem', detail: syncMessage(sync), action: 'account' };
    case 'outdated':
      return { label: 'Update required', tone: 'problem' };
    case 'too_large':
      return { label: 'Too large to upload', tone: 'problem', detail: syncMessage(sync) };
    case 'failed':
    case 'unavailable':
      return { label: 'Upload failed', tone: 'problem', detail: `Retrying in a minute.${last}` };
    default:
      return { label: 'Not synced yet', tone: 'idle' };
  }
}

// `children` holds controls shown beside the label, such as Sync now.
export function SyncStatus({
  status,
  busy,
  onReconnect,
  children,
}: {
  status: StatusResponse;
  busy: boolean;
  onReconnect: () => void;
  children?: ReactNode;
}) {
  const summary = summarize(status, busy);
  return (
    <section className="grid gap-2" aria-label="Sync status" aria-live="polite">
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex min-w-0 items-center gap-2">
          <span
            aria-hidden="true"
            className={`size-2 shrink-0 rounded-full ${
              summary.tone === 'ok' ? 'bg-foreground' : summary.tone === 'problem' ? 'bg-destructive' : 'bg-input'
            }`}
          />
          <span className="truncate">{summary.label}</span>
        </span>
        {children && <span className="flex shrink-0 gap-1">{children}</span>}
      </div>
      {status.account.state === 'syncing' && <p className={hint}>Syncs to {status.account.email}</p>}
      {summary.detail && <p className={hint}>{summary.detail}</p>}
      {summary.action === 'reconnect' && (
        <div>
          <Button variant="secondary" size="sm" disabled={busy} onClick={onReconnect}>
            Reconnect
          </Button>
        </div>
      )}
      {summary.action === 'account' && (
        <div>
          <a
            className={buttonVariants({ variant: 'secondary', size: 'sm' })}
            href={`${status.origin}/account`}
            target="_blank"
            rel="noreferrer"
          >
            Open your account
          </a>
        </div>
      )}
    </section>
  );
}
