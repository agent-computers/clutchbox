import { type CaptureRequest, type StatusResponse, siteName, siteOfInput } from '@agent-computers/capture';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { allSitesOffered, distribution } from '../../src/build';
import { serverOrigin } from '../../src/server';
import { Button } from '../../src/ui/components/button';
import { Input } from '../../src/ui/components/input';
import { Connections, connectionName, otherHost, receives } from '../../src/ui/connections';
import { AllSitesDisclosure, SitesDisclosure } from '../../src/ui/disclosures';
import { SuggestedSites } from '../../src/ui/suggested-sites';
import { hint, SyncStatus } from '../../src/ui/sync-status';
import { pendingMessage, useCaptureActions } from '../../src/ui/use-capture-actions';

// Opening the popup grants activeTab, which is what lets it read the current tab's address.
async function currentSite(): Promise<string | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url && /^https?:/.test(tab.url) ? (siteOfInput(tab.url) ?? null) : null;
}
const version = chrome.runtime.getManifest().version;
const heading = 'font-heading text-xl font-medium';
const section = 'grid gap-3 border-t pt-4';
// Sites and exclusions are also managed on the server's account page.
const openAccount = (origin: string) => void chrome.tabs.create({ url: `${origin}/account#extension` });
// Live view runs on the server's website, which holds the stream; the extension only opens it.
const openLiveView = (origin: string) => void chrome.tabs.create({ url: `${origin}/computer` });

export function App() {
  const [view, setView] = useState<'home' | 'add' | 'settings'>('home');
  const [allSitesOpen, setAllSitesOpen] = useState(false);
  const [site, setSite] = useState('');
  // The connection the popup acts on: the one it showed last until one is picked.
  const [selected, setSelected] = useState<string>();
  const {
    status,
    config,
    unavailable,
    notice,
    setNotice,
    run,
    busy,
    pending,
    blocked,
    newSites,
    addSites,
    removeSite,
    connect,
    reconnect,
    addedSitesOnly,
  } = useCaptureActions({ connection: selected, onGranted: () => setAllSitesOpen(false) });
  const { data: tabSite = null } = useQuery({ queryKey: ['tab'], queryFn: currentSite, staleTime: Infinity });
  const connections = status?.connections ?? [];
  const origin = status?.origin ?? serverOrigin;
  const current = connections.find(each => each.id === status?.connection);
  // Signed in to an account: the popup shows one of its organizations, and the disclosure never again.
  const signedIn = current !== undefined;

  const settings = status?.settings;
  const connected = signedIn && (settings?.connected ?? false);
  const paused = settings?.paused ?? false;
  const allSites = connected && settings?.mode === 'all';
  const sites = settings?.sites ?? [];
  const ungranted = status?.ungrantedSites ?? [];
  // Waiting for Reconnect, nothing reaches the account.
  const ended = status?.account.state === 'reconnect';
  const addByAddress = () => {
    const added = siteOfInput(site);
    if (!added) {
      setNotice('Enter a site, such as github.com, or paste its address.');
      return;
    }
    const reason = blocked(added);
    if (reason) {
      setNotice(reason);
      return;
    }
    const next = newSites(added);
    if (next.length) addSites(next);
    setSite('');
  };
  const open = (next: typeof view) => {
    setView(next);
    setAllSitesOpen(false);
  };
  const select = (connection: string) => {
    setSelected(connection);
    setView('home');
    setAllSitesOpen(false);
  };
  // The other organizations this site syncs to.
  const elsewhere = (site: string) =>
    connections.filter(each => each.id !== current?.id && receives(each, site)).map(connectionName);

  const allSitesDisclosure = (
    <AllSitesDisclosure disabled={busy || pending || !status} onAgree={() => connect('all')} />
  );

  return (
    <main className="mx-auto grid w-[400px] max-w-full gap-5 p-5 font-sans text-sm leading-relaxed">
      <header className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="font-serif text-lg font-medium italic">clutchbox</span>
          {current && (
            <span className="truncate font-medium" title={otherHost(current) || undefined}>
              {connectionName(current)}
              {otherHost(current) && <span className="text-muted-foreground"> · {otherHost(current)}</span>}
            </span>
          )}
        </span>
        {!signedIn ? null : view === 'home' ? (
          <nav className="flex gap-1">
            <Button variant="ghost" size="sm" onClick={() => openAccount(origin)}>
              Account
            </Button>
            <Button variant="ghost" size="sm" onClick={() => open('settings')}>
              Settings
            </Button>
          </nav>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => open('home')}>
            Done
          </Button>
        )}
      </header>

      {status && (status.update || status.sync.state === 'outdated') && (
        <aside className="flex items-center justify-between gap-3 rounded-lg bg-card p-3 text-[13px]" role="status">
          <span className="text-foreground">
            {status.update
              ? `Version ${status.update} is available.`
              : status.noUpdate
                ? 'Chrome has no update yet. Sync resumes once it installs one.'
                : 'An update is required to sync.'}
          </span>
          {/* Store builds update through Chrome; manual builds from the account page. */}
          {distribution === 'store' ? (
            <Button size="sm" disabled={busy} onClick={() => run({ type: 'update' })}>
              Update now
            </Button>
          ) : (
            <Button size="sm" onClick={() => openAccount(origin)}>
              Get the update
            </Button>
          )}
        </aside>
      )}
      {status?.signOutFailed && (
        <p className="rounded-lg bg-muted p-3 text-[13px] text-destructive" role="status">
          Signed out, but {new URL(status.signOutFailed).host} didn't confirm it deleted what this browser synced. Use
          Delete everything on its Browser sync page.
        </p>
      )}
      {view === 'home' && (
        <Connections
          connections={connections}
          selected={status?.connection}
          site={tabSite}
          disabled={busy}
          onSelect={select}
        />
      )}
      {signedIn && !connected && view === 'home' ? (
        <section className="grid justify-items-start gap-2 rounded-lg bg-card p-4" aria-label="Not syncing">
          <p className="text-foreground">
            {status?.sync.state === 'removed'
              ? `${connectionName(current)} removed this browser on its Browser sync page, or turned sync off there.`
              : `This browser no longer allows all sites, so it stopped syncing to ${connectionName(current)}.`}
          </p>
          <Button size="sm" disabled={busy || pending} onClick={() => connect('sites')}>
            Sync to {connectionName(current)} again
          </Button>
          <p className={hint}>Syncs the sites you add for {connectionName(current)}.</p>
        </section>
      ) : !signedIn ? (
        <Connect
          status={status}
          tabSite={tabSite}
          busy={busy}
          pending={pending}
          canAdd={tabSite !== null && !blocked(tabSite)}
          onConnect={() => connect('sites', tabSite && !blocked(tabSite) ? newSites(tabSite) : [])}
          allSitesOpen={allSitesOpen}
          onAllSites={() => setAllSitesOpen(open => !open)}
          allSitesDisclosure={allSitesDisclosure}
          onRemoveAccess={() => run({ type: 'disconnect' })}
        />
      ) : view === 'home' ? (
        <>
          {status && (
            <SyncStatus status={status} busy={busy} onReconnect={reconnect}>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || paused || ended}
                onClick={() => run({ type: 'capture' })}
              >
                Sync now
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || (paused && ended)}
                onClick={() => run({ type: paused ? 'resume' : 'pause' })}
              >
                {paused ? 'Resume' : 'Pause'}
              </Button>
            </SyncStatus>
          )}
          {!allSites && ungranted.length > 0 && (
            <section className="grid justify-items-start gap-2 rounded-lg bg-card p-4" aria-label="Sites to allow">
              <p className="text-foreground">
                Your account syncs {ungranted.map(each => siteName(each, config.suggestedSites)).join(', ')}, which this
                browser has not allowed yet.
              </p>
              <Button size="sm" disabled={busy || pending || ended} onClick={() => addSites(ungranted)}>
                Allow {ungranted.length === 1 ? 'it' : 'them'}
              </Button>
            </section>
          )}
          <section className="grid gap-3 rounded-lg bg-card p-4" aria-label="This site" aria-live="polite">
            {!tabSite ? (
              <p className="text-foreground">
                {allSites
                  ? 'All sites in this profile are synced, except exclusions.'
                  : 'Open a site you are signed in to, then add it here.'}
              </p>
            ) : (
              <>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-heading text-xl font-medium break-all">{tabSite}</span>
                  {!blocked(tabSite) && (allSites || (sites.includes(tabSite) && !ungranted.includes(tabSite))) && (
                    <span className="text-[13px] text-foreground">Synced</span>
                  )}
                </div>
                {!blocked(tabSite) && elsewhere(tabSite).length > 0 && (
                  <p className={hint}>Also syncs to {elsewhere(tabSite).join(', ')}.</p>
                )}
                {blocked(tabSite) ? (
                  <p className={hint}>{blocked(tabSite)}</p>
                ) : allSites ? (
                  <p className={hint}>All sites in this profile are synced, except exclusions.</p>
                ) : sites.includes(tabSite) && !ungranted.includes(tabSite) ? (
                  <div className="grid justify-items-start gap-2">
                    <p className={hint}>Your agents get this site's sign-in at each sync.</p>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy || pending}
                      onClick={() => removeSite(tabSite)}
                    >
                      Remove this site
                    </Button>
                  </div>
                ) : (
                  <Button size="lg" disabled={busy || pending || ended} onClick={() => addSites(newSites(tabSite))}>
                    {connections.length > 1 && current
                      ? `Add this site to ${connectionName(current)}`
                      : 'Add this site'}
                  </Button>
                )}
              </>
            )}
          </section>
          {!allSites && (
            <form
              className="flex gap-2"
              onSubmit={event => {
                event.preventDefault();
                addByAddress();
              }}
            >
              <Input
                aria-label="Add a site by address"
                placeholder="Add another site, such as github.com"
                value={site}
                disabled={busy}
                onChange={event => setSite(event.target.value)}
              />
              <Button type="submit" variant="secondary" disabled={busy || pending || ended || !site.trim()}>
                Add
              </Button>
            </form>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            {!allSites && (
              <Button variant="link" className="h-auto px-0" onClick={() => open('add')}>
                Add more sites
              </Button>
            )}
            <Button variant="secondary" size="sm" className="ml-auto" onClick={() => openLiveView(origin)}>
              Open live view
            </Button>
          </div>
        </>
      ) : view === 'add' ? (
        <section className="grid gap-3" aria-labelledby="add-heading">
          <h2 id="add-heading" className={heading}>
            Add more sites
          </h2>
          <SuggestedSites
            config={config}
            origin={origin}
            sites={sites}
            blocked={blocked}
            disabled={busy || pending}
            onAdd={addSites}
            hideAdded
            size="sm"
          />
          <p className={hint}>Each site includes its subdomains. Your browser may ask you to allow it.</p>
        </section>
      ) : (
        status && (
          <Settings
            status={status}
            busy={busy}
            allSites={allSites}
            allSitesOpen={allSitesOpen}
            onAllSites={() => setAllSitesOpen(true)}
            allSitesDisclosure={allSitesDisclosure}
            onAddedSitesOnly={addedSitesOnly}
            run={run}
          />
        )
      )}

      {pending && !busy && (
        <p className={hint} role="status">
          {pendingMessage}
        </p>
      )}
      {(notice || unavailable) && (
        <p className="rounded-lg bg-muted p-3 text-[13px] text-destructive" role="status">
          {notice || 'Extension unavailable. Reopen to try again.'}
        </p>
      )}
    </main>
  );
}

// Signing in to an account, shown only until the browser is signed in to one.
function Connect(props: {
  status: StatusResponse | undefined;
  tabSite: string | null;
  busy: boolean;
  // A click elsewhere is waiting for Chrome's prompt.
  pending: boolean;
  canAdd: boolean;
  onConnect: () => void;
  allSitesOpen: boolean;
  onAllSites: () => void;
  allSitesDisclosure: ReactNode;
  onRemoveAccess: () => void;
}) {
  const { status, tabSite, busy, pending, canAdd } = props;
  return (
    <>
      <h1 className="font-heading text-[32px] leading-[1.05] font-medium tracking-[-0.015em]">
        Keep your agents signed in.
      </h1>
      <SitesDisclosure />
      <div className="grid gap-2">
        <Button size="lg" disabled={busy || pending || !status} onClick={props.onConnect}>
          {canAdd ? `Agree and add ${tabSite}` : 'Agree and connect'}
        </Button>
        <p className={hint}>
          {status?.connecting
            ? 'Finish signing in in the Clutchbox tab.'
            : 'Opens Clutchbox in a tab, where you sign in. Then add sites for each of your organizations here.'}
        </p>
        <div>
          {/* The setup tab has room for the address and the warning other servers need. */}
          <Button
            variant="link"
            className="h-auto px-0"
            disabled={busy}
            onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL('/setup.html#server') })}
          >
            Another server…
          </Button>
        </div>
        {allSitesOffered && (
          <div>
            <Button
              variant="link"
              className="h-auto px-0"
              disabled={busy || pending || !status}
              onClick={props.onAllSites}
            >
              Allow all sites instead…
            </Button>
          </div>
        )}
      </div>
      {props.allSitesOpen && props.allSitesDisclosure}
      {status?.permissionGranted && (
        <div className="grid justify-items-start gap-2">
          <p className={hint}>Your browser still grants access, but this browser is signed out.</p>
          <Button variant="secondary" disabled={busy} onClick={props.onRemoveAccess}>
            Remove browser access
          </Button>
        </div>
      )}
    </>
  );
}

function Settings(props: {
  status: StatusResponse;
  busy: boolean;
  allSites: boolean;
  allSitesOpen: boolean;
  onAllSites: () => void;
  allSitesDisclosure: ReactNode;
  onAddedSitesOnly: () => void;
  run: (request: CaptureRequest) => void;
}) {
  const { status, busy, allSites, run } = props;
  const { sites, excludedDomains } = status.settings;
  const current = status.connections.find(each => each.id === status.connection);
  const name = current ? connectionName(current) : 'this organization';
  const [confirm, setConfirm] = useState(false);
  // Every organization on this server, which Sign out stops syncing to.
  const signedOut = status.connections.filter(each => each.origin === status.origin).map(connectionName);
  const host = new URL(status.origin).host;
  const email = status.account.state === 'none' ? undefined : status.account.email;
  return (
    <>
      <section className="grid justify-items-start gap-3" aria-labelledby="manage-heading">
        <h2 id="manage-heading" className={heading}>
          Sites and exclusions
        </h2>
        <p className={hint}>
          {allSites ? 'All sites' : `${sites.length} ${sites.length === 1 ? 'site' : 'sites'}`},{' '}
          {excludedDomains.length} {excludedDomains.length === 1 ? 'exclusion' : 'exclusions'}. Remove sites and edit
          exclusions on your account page.
        </p>
        <Button variant="secondary" onClick={() => openAccount(status.origin)}>
          Manage on your account
        </Button>
      </section>

      <section className={section} aria-labelledby="access-heading">
        <h2 id="access-heading" className={heading}>
          Browser access
        </h2>
        {allSites ? (
          <div className="grid justify-items-start gap-2">
            <p className={hint}>
              All sites are synced. Use added sites only keeps this browser connected and allows the sites you added
              again; any your browser doesn't allow are listed to allow.
            </p>
            <Button variant="secondary" disabled={busy} onClick={props.onAddedSitesOnly}>
              Use added sites only
            </Button>
          </div>
        ) : props.allSitesOpen ? (
          props.allSitesDisclosure
        ) : (
          allSitesOffered && (
            <div>
              <Button variant="link" className="h-auto px-0" disabled={busy} onClick={props.onAllSites}>
                Allow all sites instead…
              </Button>
            </div>
          )
        )}
      </section>

      <section className={section} aria-labelledby="account-heading">
        <h2 id="account-heading" className={heading}>
          Account
        </h2>
        <p className={hint}>
          {email ? `Signed in as ${email} on ${host}. ` : `Signed in on ${host}. `}
          Sites and exclusions are {name}'s own; switch organizations above.
        </p>
        {confirm ? (
          <div className="grid justify-items-start gap-2 rounded-lg bg-muted p-3">
            <p className="text-foreground">
              Sign out of Clutchbox in this browser? Your agents lose the sign-ins it synced to {signedOut.join(', ')}.
              It does not sign you out of websites.
            </p>
            <div className="flex gap-2">
              <Button variant="destructive" size="sm" disabled={busy} onClick={() => run({ type: 'disconnect' })}>
                Sign out
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirm(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" disabled={busy} onClick={() => setConfirm(true)}>
              Sign out
            </Button>
            <Button
              variant="link"
              className="h-auto px-0"
              onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL('/setup.html#server') })}
            >
              Another server…
            </Button>
          </div>
        )}
      </section>

      <footer className="grid gap-2 border-t pt-4 text-xs text-muted-foreground">
        <p>Syncs cookies only: not page storage, files, or incognito windows.</p>
        <div className="flex justify-between">
          <a
            className="underline underline-offset-2"
            href={`${status.origin}/privacy`}
            target="_blank"
            rel="noreferrer"
          >
            Privacy policy
          </a>
          <span>Version {version}</span>
        </div>
      </footer>
    </>
  );
}
