'use client';
import { exclusionsSchema, type SyncSettings } from '@agent-computers/capture';
import { siteGroups } from '@agent-computers/capture/sites';
import { Alert, AlertDescription } from '@agent-computers/ui/components/alert';
import { Button } from '@agent-computers/ui/components/button';
import { Label } from '@agent-computers/ui/components/label';
import { Textarea } from '@agent-computers/ui/components/textarea';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, browsersQuery, computerQuery, type SyncChange, type SyncView, setupQuery, syncQuery } from '../lib/api';

const heading = 'font-heading text-xl font-medium';

// The account's sites, exclusions, and pause. From here they can only narrow what is captured, except
// exclusions, which edit either way: adding sites and resuming happen in the extension. The extension picks changes up
// at its next sync; the server applies them to the uploaded copy at once.
export function SyncSettingsPanel({
  view,
  settings,
  allSites,
}: {
  view: SyncView;
  settings: SyncSettings;
  allSites: boolean;
}) {
  const queryClient = useQueryClient();
  const refresh = () =>
    Promise.all(
      [syncQuery, setupQuery, computerQuery, browsersQuery].map(query =>
        queryClient.invalidateQueries({ queryKey: query.queryKey }),
      ),
    );
  const change = useMutation({
    mutationFn: (body: SyncChange) => api<{ settings: SyncSettings }>('/sync', 'PATCH', body),
    onSuccess: ({ settings }) => {
      queryClient.setQueryData(syncQuery.queryKey, { ...view, settings });
      return refresh();
    },
  });
  const turnOff = useMutation({ mutationFn: () => api('/sync/disconnect', 'POST'), onSuccess: refresh });
  const busy = change.isPending || turnOff.isPending;
  const error = change.error ?? turnOff.error;

  return (
    <div className="grid gap-6">
      <section className="grid gap-2" aria-labelledby="synced-sites-heading">
        <h2 id="synced-sites-heading" className={heading}>
          Synced sites
        </h2>
        {allSites ? (
          <p className="text-sm">All sites, except domains you exclude.</p>
        ) : settings.sites.length ? (
          <ul className="text-sm">
            {siteGroups(settings.sites).map(group => (
              <li key={group.name} className="flex items-center justify-between gap-3 border-b py-1.5">
                <span>{group.name}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  aria-label={`Remove ${group.name}`}
                  onClick={() => change.mutate({ removeSites: group.sites })}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm">No sites added yet.</p>
        )}
        <p className="text-sm text-foreground">
          Add a site from the extension while you're on it. Removing one deletes its synced copy, and your agent
          computer forgets it the next time an agent opens it.
        </p>
      </section>
      <Exclusions
        saved={settings.excludedDomains}
        busy={busy}
        onSave={(excludedDomains, done) => change.mutate({ excludedDomains }, { onSuccess: done })}
      />
      <section className="grid justify-items-start gap-3" aria-labelledby="sync-controls-heading">
        <h2 id="sync-controls-heading" className={heading}>
          Sync
        </h2>
        {view.disconnected ? (
          <p className="text-sm text-foreground">
            Browser sync is off here. Add a site for this organization in the extension to turn it back on.
          </p>
        ) : (
          <>
            {settings.paused ? (
              <p className="text-sm text-foreground">Paused. Resume from the extension in your browser.</p>
            ) : (
              <div className="grid justify-items-start gap-2">
                <Button variant="secondary" disabled={busy} onClick={() => change.mutate({ paused: true })}>
                  Pause sync
                </Button>
                <p className="text-sm text-foreground">Your agents keep the last copy. Resume from the extension.</p>
              </div>
            )}
            <div className="grid justify-items-start gap-2">
              <Button variant="secondary" disabled={busy} onClick={() => turnOff.mutate()}>
                Turn off sync
              </Button>
              <p className="text-sm text-foreground">
                Deletes the synced copy and removes every browser from this organization; add a site in the extension to
                sync here again. Your sites and exclusions are kept.
              </p>
            </div>
          </>
        )}
      </section>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function Exclusions({
  saved,
  busy,
  onSave,
}: {
  saved: string[];
  busy: boolean;
  onSave: (excludedDomains: string[], done: () => void) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const text = draft ?? saved.join('\n');
  return (
    <section className="grid gap-2" aria-labelledby="exclusions-heading">
      <h2 id="exclusions-heading" className={heading}>
        Exclusions
      </h2>
      <Label htmlFor="exclusions">Domains never to sync (one per line)</Label>
      <Textarea
        id="exclusions"
        rows={3}
        placeholder="example.com"
        value={text}
        disabled={busy}
        aria-describedby="exclusions-help"
        aria-invalid={invalid}
        onChange={event => {
          setDraft(event.target.value);
          setInvalid(false);
        }}
      />
      <p id="exclusions-help" className="text-sm text-foreground">
        {invalid
          ? 'Enter up to 100 domains, one per line, without addresses, paths, ports, or wildcards.'
          : 'Includes subdomains, shared parent-domain cookies, and related partitioned cookies, which can affect sign-in on other sites. Excluding a site you added removes it.'}
      </p>
      <div>
        <Button
          variant="secondary"
          disabled={busy || draft === null || draft === saved.join('\n')}
          onClick={() => {
            const parsed = exclusionsSchema.safeParse(text.split('\n').filter(line => line.trim()));
            if (!parsed.success) {
              setInvalid(true);
              return;
            }
            onSave(parsed.data, () => setDraft(null));
          }}
        >
          Save exclusions
        </Button>
      </div>
    </section>
  );
}
