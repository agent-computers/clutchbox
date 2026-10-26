import type { ServerResponse } from '@agent-computers/capture';
import { useEffect, useState } from 'react';
import { allSitesOffered } from '../../src/build';
import { serverOrigin } from '../../src/server';
import { AnotherServer, ServerWarning } from '../../src/ui/another-server';
import { Button } from '../../src/ui/components/button';
import { Connections, connectionName } from '../../src/ui/connections';
import { AllSitesDisclosure, SitesDisclosure } from '../../src/ui/disclosures';
import { SuggestedSites } from '../../src/ui/suggested-sites';
import { hint, SyncStatus, syncMessage } from '../../src/ui/sync-status';
import { pendingMessage, type ServerChoice, useCaptureActions } from '../../src/ui/use-capture-actions';

const heading = 'font-heading text-2xl font-medium';

// The tab that opens on install: agree and connect, then add sites from the suggestions. `#server` (from the popup)
// opens Connect to another server.
export function App() {
  const [allSitesOpen, setAllSitesOpen] = useState(false);
  // As in the popup: the connection this tab acts on, or connecting another organization, on the build's server or
  // `server`.
  const [selected, setSelected] = useState<string>();
  const [another, setAnother] = useState<{ before: string[]; server?: ServerChoice; name?: string }>();
  const [serverOpen, setServerOpen] = useState(() => location.hash === '#server');
  // A server outside the verified list, waiting for the person's answer to its warning.
  const [warning, setWarning] = useState<string>();
  const { status, config, unavailable, notice, busy, pending, blocked, addSites, connect, reconnect } =
    useCaptureActions({
      connection: selected,
      another: !!another,
      server: another?.server,
      onGranted: () => setAllSitesOpen(false),
    });
  const connections = status?.connections ?? [];
  const added = another && connections.find(each => !another.before.includes(each.id));
  useEffect(() => {
    if (!added) return;
    setSelected(added.id);
    setAnother(undefined);
  }, [added]);
  const origin = another?.server?.origin ?? status?.origin ?? serverOrigin;
  const before = connections.map(each => each.id);
  const chooseServer = ({ origin: chosen, trust, name }: ServerResponse) => {
    setServerOpen(false);
    if (trust === 'unverified') setWarning(chosen);
    else
      setAnother({
        before,
        ...(trust === 'build' ? {} : { server: { origin: chosen } }),
        ...(name ? { name } : {}),
      });
  };
  const host = new URL(origin).host;
  const current = connections.find(each => each.id === status?.connection);
  const settings = status?.settings;
  const connected = !another && (settings?.connected ?? false);
  const allSites = connected && settings?.mode === 'all';
  const sites = settings?.sites ?? [];
  const saved = connected || another ? 0 : sites.length;
  const syncState = another ? undefined : status?.sync.state;

  const header = (
    <header>
      <span className="font-serif text-lg font-medium italic">clutchbox</span>
    </header>
  );
  if (warning)
    return (
      <main className="mx-auto grid w-full max-w-2xl gap-8 px-6 py-12 font-sans text-sm leading-relaxed">
        {header}
        <ServerWarning
          origin={warning}
          onBack={() => setWarning(undefined)}
          onAgree={() => {
            setAnother({ before, server: { origin: warning, warned: true } });
            setWarning(undefined);
          }}
        />
      </main>
    );

  return (
    <main className="mx-auto grid w-full max-w-2xl gap-8 px-6 py-12 font-sans text-sm leading-relaxed">
      {header}
      <h1 className="font-heading text-[40px] leading-[1.05] font-medium tracking-[-0.015em]">
        Keep your agents signed in.
      </h1>

      <Connections
        connections={connections}
        selected={status?.connection}
        another={!!another}
        disabled={busy}
        onSelect={connection => {
          setSelected(connection);
          setAnother(undefined);
        }}
        onAnother={() => setAnother({ before })}
      />
      {status && connected && <SyncStatus status={status} busy={busy} onReconnect={reconnect} />}
      {!connected && syncState === 'delete_failed' && status && <p className={hint}>{syncMessage(status.sync)}</p>}

      <section className="grid gap-3" aria-labelledby="agree-heading">
        <h2 id="agree-heading" className={heading}>
          Browser sync
        </h2>
        <SitesDisclosure />
        {connected ? (
          <p className="text-soft">Connected{current ? ` to ${connectionName(current)}` : ''}</p>
        ) : (
          <div className="grid justify-items-start gap-2">
            <Button size="lg" disabled={busy || pending || !status} onClick={() => connect('sites')}>
              Agree and connect
            </Button>
            {status?.connecting ? (
              <p className={hint}>Finish connecting in the server's tab.</p>
            ) : (
              another && (
                <p className={hint}>
                  Connects the organization you are using on{' '}
                  {another.server ? `${host}${another.name ? ` (verified as ${another.name})` : ''}` : 'Clutchbox'}, so
                  switch to the one you want there first.
                </p>
              )
            )}
            <Button
              variant="link"
              className="h-auto px-0"
              disabled={busy || pending}
              onClick={() => setServerOpen(open => !open)}
            >
              {another?.server ? 'Connect to a different server…' : 'Connect to another server…'}
            </Button>
            {serverOpen && <AnotherServer disabled={busy || pending} onChoose={chooseServer} />}
            {saved > 0 && (
              <p className={hint}>
                Also restores the {saved === 1 ? 'site' : `${saved} sites`} you added before, if you connect to the same
                account.
              </p>
            )}
          </div>
        )}
      </section>

      <section className="grid gap-3" aria-labelledby="sites-heading">
        <h2 id="sites-heading" className={heading}>
          Sites
        </h2>
        {allSites ? (
          <p className="text-soft">All sites in this browser profile sync.</p>
        ) : (
          <>
            <p className={hint}>
              {connected
                ? 'Add the sites your agents should use. Your browser may ask you to allow each one.'
                : 'Agree and connect first, then add the sites your agents should use.'}
            </p>
            <SuggestedSites
              config={config}
              origin={origin}
              sites={sites}
              blocked={blocked}
              disabled={!connected || busy || pending}
              onAdd={addSites}
            />
            <p className={hint}>
              Add any other site from the extension's menu while you are on it. Remove sites and edit exclusions on your
              account page.
            </p>
          </>
        )}
        {allSitesOffered && !allSites && (
          <div className="grid gap-3">
            <div>
              <Button
                variant="link"
                className="h-auto px-0"
                disabled={busy || pending || !status}
                onClick={() => setAllSitesOpen(open => !open)}
              >
                Allow all sites instead…
              </Button>
            </div>
            {allSitesOpen && (
              <AllSitesDisclosure disabled={busy || pending || !status} onAgree={() => connect('all')} />
            )}
          </div>
        )}
      </section>

      {pending && !busy && (
        <p className={hint} role="status">
          {pendingMessage}
        </p>
      )}
      {(notice || unavailable) && (
        <p className="rounded-lg bg-muted p-3 text-[13px] text-destructive" role="status">
          {notice || 'Extension unavailable. Reload this page to try again.'}
        </p>
      )}

      <footer className="border-t pt-4">
        <a className="underline underline-offset-2" href={`${origin}/account`}>
          Back to your account
        </a>
      </footer>
    </main>
  );
}
