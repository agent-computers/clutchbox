import { useState } from 'react';
import { allSitesOffered } from '../../src/build';
import { serverOrigin } from '../../src/server';
import { Button } from '../../src/ui/components/button';
import { AllSitesDisclosure, SitesDisclosure } from '../../src/ui/disclosures';
import { SuggestedSites } from '../../src/ui/suggested-sites';
import { hint, SyncStatus, syncMessage } from '../../src/ui/sync-status';
import { pendingMessage, useCaptureActions } from '../../src/ui/use-capture-actions';

const heading = 'font-heading text-2xl font-medium';

// The tab that opens on install: agree and connect, then add sites from the suggestions.
export function App() {
  const [allSitesOpen, setAllSitesOpen] = useState(false);
  const { status, config, unavailable, notice, busy, pending, blocked, addSites, connect, reconnect } =
    useCaptureActions({
      onGranted: () => setAllSitesOpen(false),
    });
  const settings = status?.settings;
  const connected = settings?.connected ?? false;
  const allSites = connected && settings?.mode === 'all';
  const sites = settings?.sites ?? [];
  const saved = connected ? 0 : sites.length;
  const syncState = status?.sync.state;

  return (
    <main className="mx-auto grid w-full max-w-2xl gap-8 px-6 py-12 font-sans text-sm leading-relaxed">
      <header>
        <span className="font-serif text-lg font-medium italic">agent computers</span>
      </header>
      <h1 className="font-heading text-[40px] leading-[1.05] font-medium tracking-[-0.015em]">
        Keep your agent computer signed in.
      </h1>

      {status && connected && <SyncStatus status={status} busy={busy} onReconnect={reconnect} />}
      {!connected && syncState === 'delete_failed' && status && <p className={hint}>{syncMessage(status.sync)}</p>}

      <section className="grid gap-3" aria-labelledby="agree-heading">
        <h2 id="agree-heading" className={heading}>
          Browser sync
        </h2>
        <SitesDisclosure />
        {connected ? (
          <p className="text-soft">Connected</p>
        ) : (
          <div className="grid justify-items-start gap-2">
            <Button size="lg" disabled={busy || pending || !status} onClick={() => connect('sites')}>
              Agree and connect
            </Button>
            {status?.connecting && <p className={hint}>Finish connecting in the Agent Computers tab.</p>}
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
        <a className="underline underline-offset-2" href={`${serverOrigin}/account`}>
          Back to your account
        </a>
      </footer>
    </main>
  );
}
