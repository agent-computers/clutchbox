/// <reference types="next/image-types/global" />
'use client';
import { siteGroups } from '@agent-computers/capture/sites';
import { Button, buttonVariants } from '@agent-computers/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@agent-computers/ui/components/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@agent-computers/ui/components/collapsible';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import Image from 'next/image';
import { type ReactNode, useSyncExternalStore } from 'react';
import installPicture from '../assets/extension-install.png';
import { useShell } from '../deployment';
import { type ComputerView, computerQuery, setupQuery, syncQuery } from '../lib/api';
import { isSupportedBrowser } from '../lib/setup';
import { AppPage } from './app-shell';
import { ConnectedBrowsers } from './connected-browsers';
import { CopyButton } from './copy-button';
import { SyncSettingsPanel } from './sync-settings';

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
function captureLines({ capture, computer }: ComputerView) {
  if (!capture) return [];
  const applied = computer?.appliedCaptureAt;
  return [
    `Copied from your browser ${when(capture.completedAt)} (${capture.cookieCount.toLocaleString()} cookies, checked ${when(capture.uploadedAt)}).`,
    applied && Date.parse(applied) >= Date.parse(capture.completedAt)
      ? 'Applied to your computer.'
      : `Applies the next time an agent opens your computer${applied ? `, which has the copy from ${when(applied)}` : ''}.`,
  ];
}
// The server renders as supported, so the first paint matches; the browser then checks its own client hints.
const noSubscription = () => () => {};
function useSupportedBrowser() {
  return useSyncExternalStore(
    noSubscription,
    () =>
      isSupportedBrowser(
        navigator.userAgent,
        (navigator as Navigator & { userAgentData?: Parameters<typeof isSupportedBrowser>[1] }).userAgentData,
      ),
    () => true,
  );
}

const update =
  'Already installed? To update, replace the folder with the new one and click reload on chrome://extensions. Your sites are kept. Coming from a version before 26.1021.2, choose Reconnect in the extension once.';
function Step({ number, title, children }: { number: number; title: string; children?: ReactNode }) {
  return (
    <li className="grid grid-cols-[1.75rem_1fr] gap-x-3">
      <span
        aria-hidden
        className="grid size-7 place-items-center rounded-full bg-muted text-xs text-muted-foreground tabular-nums"
      >
        {number}
      </span>
      <div className="grid gap-2 pt-1">
        <p className="font-medium">{title}</p>
        {children}
      </div>
    </li>
  );
}
// Pages cannot link to chrome:// URLs, so step 2 offers a copy instead. Other Chromium browsers redirect it to their own
// extensions page.
function InstallSteps() {
  return (
    <ol className="grid gap-4 text-sm">
      <Step number={1} title="Unzip the download and keep the folder. The extension runs from it." />
      <Step number={2} title="Go to this address in a new tab.">
        <div className="flex flex-wrap items-center gap-3">
          <code className="rounded-md bg-muted px-2 py-1 font-sans">chrome://extensions</code>
          <CopyButton text="chrome://extensions" label="Copy chrome://extensions" />
        </div>
      </Step>
      <Step number={3} title="Turn on Developer mode, choose Load unpacked, and select the folder.">
        {/* A rendered picture of chrome://extensions with Developer mode and Load unpacked ringed. */}
        <Image
          src={installPicture}
          width={800}
          height={115}
          sizes="(max-width: 767px) 100vw, 680px"
          className="w-full rounded-md border"
          alt="Chrome's extensions page, with the Developer mode switch at the top right and the Load unpacked button below the page title"
        />
      </Step>
      <Step number={4} title="In the tab that opens, choose Agree and connect, then add your sites." />
    </ol>
  );
}

// The Browser sync page. The popup links to /account#extension, which now lands here. With the deployment's Chrome Web
// Store listing, it leads with that, which Chrome keeps updated, and the manual install stays for Allow all sites,
// which only the unpacked build offers. Without one, the manual install is the only way.
export function BrowserSync({
  accountUrl,
  extensionVersion,
  extensionDownloadUrl,
}: {
  accountUrl: string;
  extensionVersion: string;
  extensionDownloadUrl: string;
}) {
  const { data: setup } = useQuery(setupQuery);
  const { data: view } = useQuery(computerQuery);
  const { data: syncView } = useQuery(syncQuery);
  const sync = setup?.sync ?? { mode: null, sites: [], readable: true };
  const settings = syncView?.settings;
  const supported = useSupportedBrowser();
  const lines = view ? captureLines(view) : [];
  // Synced, as the server sees it: a scope, or a capture it cannot list.
  const synced = sync.mode !== null || !sync.readable;
  const installed = synced || !!settings;
  const { chromeWebStoreUrl } = useShell();
  const manual = (
    <>
      <div className="flex flex-wrap items-center gap-4">
        <a
          className={buttonVariants({ variant: chromeWebStoreUrl || installed ? 'outline' : 'default' })}
          href={extensionDownloadUrl}
          download
        >
          Download the extension
        </a>
        <span className="text-sm text-muted-foreground tabular-nums">Version {extensionVersion}</span>
      </div>
      <InstallSteps />
      <p className="text-sm text-soft">{update}</p>
    </>
  );
  const extension = (
    <Card key="extension" id="extension" className="scroll-mt-6">
      <CardHeader>
        <CardTitle>
          <h2>{installed ? 'Extension' : 'Install the extension'}</h2>
        </CardTitle>
        <CardDescription>
          {chromeWebStoreUrl
            ? 'Install it from the Chrome Web Store. Chrome keeps it up to date.'
            : 'Download it and load it in Developer mode. You update it by hand.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        {!supported && (
          <div role="note" className="grid gap-3 rounded-lg bg-muted p-4 text-sm">
            <p>To install, open this page in Chrome, Edge, Brave, or Arc on your computer.</p>
            <div>
              <CopyButton text={accountUrl} label="Copy the link to this page" />
            </div>
          </div>
        )}
        {!chromeWebStoreUrl ? (
          manual
        ) : (
          <>
            <div>
              <a
                className={buttonVariants({ variant: installed ? 'outline' : 'default' })}
                href={chromeWebStoreUrl}
                target="_blank"
                rel="noopener"
              >
                Add to Chrome
              </a>
            </div>
            {installed ? (
              <p className="text-sm text-soft">
                Installed it by hand? To switch, remove that copy on chrome://extensions first, so the two don't upload
                over each other. Your sites carry over; the new copy asks you to allow each one again.
                {sync.mode === 'whole-browser' && ' It syncs only the sites you add, not all sites.'}
              </p>
            ) : (
              <p className="text-sm text-soft">
                If Chrome says it isn't trusted by Enhanced Safe Browsing, choose Continue to install; Chrome says that
                of extensions from new publishers. In the tab it opens, choose Agree and connect, then add your sites.
              </p>
            )}
            <Collapsible className="grid gap-4">
              <CollapsibleTrigger render={<Button variant="ghost" className="group justify-self-start" />}>
                Install manually for Allow all sites
                <ChevronDown aria-hidden className="transition-transform group-data-panel-open:rotate-180" />
              </CollapsibleTrigger>
              <CollapsibleContent className="grid gap-5">
                <p className="text-sm text-soft">
                  The manual build can also sync every site, except domains you exclude. It needs Developer mode, and
                  you update it by hand.
                </p>
                {manual}
              </CollapsibleContent>
            </Collapsible>
          </>
        )}
      </CardContent>
    </Card>
  );
  if (!installed)
    return (
      <AppPage title="Browser sync" description={description}>
        {extension}
        <ConnectedBrowsers />
      </AppPage>
    );
  return (
    <AppPage title="Browser sync" description={description}>
      <Card>
        <CardContent className="grid gap-6">
          {lines.length > 0 && (
            <div className="grid gap-1">
              {lines.map(line => (
                <p key={line} className="text-sm text-soft">
                  {line}
                </p>
              ))}
            </div>
          )}
          {syncView && settings ? (
            <SyncSettingsPanel view={syncView} settings={settings} allSites={sync.mode === 'whole-browser'} />
          ) : (
            <section className="grid gap-2">
              <h2 className="font-heading text-xl font-medium">Synced sites</h2>
              {sync.mode === 'whole-browser' ? (
                <p className="text-sm">All sites, except domains you exclude.</p>
              ) : !sync.readable ? (
                <p className="text-sm">Your sites can't be listed right now.</p>
              ) : sync.sites.length ? (
                <ul className="text-sm">
                  {siteGroups(sync.sites).map(group => (
                    <li key={group.name} className="border-b py-2.5">
                      {group.name}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm">No sites added yet.</p>
              )}
              <p className="text-sm text-soft">Update the extension to manage your sites here.</p>
            </section>
          )}
        </CardContent>
      </Card>
      <ConnectedBrowsers />
      {extension}
    </AppPage>
  );
}
const description =
  'Keeps your agent computer signed in to the sites you choose, from Chrome, Edge, Brave, or Arc. Nothing flows back to your browser.';
