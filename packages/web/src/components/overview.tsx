'use client';
import { siteGroups } from '@agent-computers/capture/sites';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@agent-computers/ui/components/alert';
import { Badge } from '@agent-computers/ui/components/badge';
import { buttonVariants } from '@agent-computers/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@agent-computers/ui/components/card';
import { Input } from '@agent-computers/ui/components/input';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CircleCheck, Eye } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { useShell } from '../deployment';
import {
  browsersQuery,
  type ComputerView,
  computerQuery,
  grantsQuery,
  type SetupView,
  setupQuery,
  syncQuery,
} from '../lib/api';
import { computerStatus, resetsOn, syncedSignIns, usedShare } from '../lib/computer';
import { extensionDownloadUrl } from '../lib/extension-download';
import { promptsFor } from '../lib/setup';
import { connectedAgents, lastUser } from './agent-connections';
import { AppPage, useAppUser } from './app-shell';
import { CopyButton } from './copy-button';
import { SetupNotice } from './setup-notice';

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

// Where the old account page's sections live now. /account redirects here with its hash (the extension popup links to
// #extension, and live view used #computer), so a known hash moves on to its page. A deployment adds its own pages.
const sectionPages: Record<string, string> = {
  '#extension': '/app/sync',
  '#browsers': '/app/sync',
  '#agents': '/app/agents',
  '#computer': '/app/computer',
  '#delete': '/app/settings',
};

// The overview: the setup checklist until the user is set up, then the state of their computer,
// sync, and agents. Setup never gates any page; the sidebar reaches every one.
export function Overview({ mcpUrl }: { mcpUrl: string }) {
  const router = useRouter();
  const shell = useShell();
  useEffect(() => {
    const hash = window.location.hash;
    const page = sectionPages[hash] ?? shell.sectionPages?.[hash];
    if (page) router.replace(page);
  }, [router, shell]);
  const first = useAppUser().name.split(' ')[0];
  const setup = useQuery(setupQuery);
  if (setup.isPending)
    return <AppPage title={`Welcome, ${first}.`}>{<p className="text-foreground">Loading…</p>}</AppPage>;
  // If setup cannot load, the status view shows plainly.
  if (setup.data && !setup.data.setUpAt) return <Checklist setup={setup.data} first={first} mcpUrl={mcpUrl} />;
  return <Status setup={setup.data} first={first} />;
}

function Checklist({ setup, first, mcpUrl }: { setup: SetupView; first: string | undefined; mcpUrl: string }) {
  const { data: grants = [] } = useQuery(grantsQuery);
  const { items, sync } = setup;
  const steps = [items.browserSync, items.agents, items.computer];
  const done = steps.filter(Boolean).length;
  const current = steps.indexOf(false);
  const used = lastUser(grants);
  const { chromeWebStoreUrl } = useShell();
  return (
    <AppPage
      title={`Welcome, ${first}.`}
      description="Three steps and your agents get a computer that's already signed in to your sites."
    >
      <div className="grid gap-2">
        <p className="flex items-baseline justify-between text-sm">
          <span>Set up</span>
          <span className="text-muted-foreground tabular-nums">{done} of 3 done</span>
        </p>
        <div className="grid grid-cols-3 gap-1.5" aria-hidden>
          {steps.map((step, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the three steps are fixed.
            <span key={index} className={`h-1 rounded-full ${step ? 'bg-foreground' : 'bg-muted'}`} />
          ))}
        </div>
      </div>
      <ol className="grid gap-3">
        <Step
          number={1}
          title="Sync your browser"
          done={items.browserSync}
          current={current === 0}
          summary={
            sync.mode === 'whole-browser'
              ? 'Synced: all sites'
              : sync.sites.length
                ? `Synced: ${siteGroups(sync.sites)
                    .map(group => group.name)
                    .join(', ')}`
                : 'Synced'
          }
          href="/app/sync"
        >
          {chromeWebStoreUrl ? (
            <>
              <p className="text-foreground">
                Install the extension in Chrome, Edge, Brave, or Arc, then choose the sites your agents can use. If
                Chrome says it isn't trusted by Enhanced Safe Browsing, choose Continue to install; Chrome says that of
                extensions from new publishers.
              </p>
              <div className="flex flex-wrap gap-3">
                <a className={buttonVariants()} href={chromeWebStoreUrl} target="_blank" rel="noopener">
                  Add to Chrome
                </a>
                <More href="/app/sync">Other ways to install</More>
              </div>
            </>
          ) : (
            <>
              <p className="text-foreground">
                Download the extension and load it in Chrome, Edge, Brave, or Arc, then choose the sites your agents can
                use.
              </p>
              <div className="flex flex-wrap gap-3">
                <a className={buttonVariants()} href={extensionDownloadUrl} download>
                  Download the extension
                </a>
                <More href="/app/sync">How to install it</More>
              </div>
            </>
          )}
        </Step>
        <Step
          number={2}
          title="Connect an agent"
          done={items.agents}
          current={current === 1}
          summary={`Connected: ${connectedAgents(grants).join(', ')}`}
          href="/app/agents"
        >
          <p className="text-foreground">Add this MCP server to Claude, ChatGPT, Claude Code, or Codex.</p>
          <div className="flex flex-wrap gap-3">
            <Input readOnly aria-label="MCP server URL" value={mcpUrl} className="min-w-60 flex-1" />
            <CopyButton text={mcpUrl} label="Copy the MCP server URL" />
          </div>
          <More href="/app/agents">Steps for your agent</More>
        </Step>
        <Step
          number={3}
          title="Let an agent open your computer"
          done={items.computer}
          current={current === 2}
          summary={used ? `Opened by ${used.name}, ${when(used.at)}` : 'Opened'}
          href="/app/computer"
        >
          <p className="text-foreground">Ask a connected agent:</p>
          <RotatingPrompt prompts={promptsFor(sync)} />
        </Step>
      </ol>
      <p className="text-sm text-muted-foreground">Setup never locks anything. Every page is in the menu.</p>
    </AppPage>
  );
}

function Step({
  number,
  title,
  done,
  current,
  summary,
  href,
  children,
}: {
  number: number;
  title: string;
  done: boolean;
  current: boolean;
  summary: string;
  href: string;
  children: ReactNode;
}) {
  return (
    <li>
      <Card size={current ? 'default' : 'sm'} className={current ? 'ring-foreground/25' : undefined}>
        <CardHeader>
          <div className="flex items-center gap-3">
            {done ? (
              <CircleCheck aria-hidden className="size-5 shrink-0" />
            ) : (
              <span
                aria-hidden
                className="grid size-5 shrink-0 place-items-center rounded-full text-[0.7rem] text-muted-foreground tabular-nums ring-1 ring-muted-foreground"
              >
                {number}
              </span>
            )}
            <CardTitle className="flex-1">
              <h2 className={current ? undefined : 'text-muted-foreground'}>
                <span className="sr-only">
                  Step {number}, {done ? 'done' : 'to do'}:{' '}
                </span>
                {title}
              </h2>
            </CardTitle>
            {done && (
              <Link href={href} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
                Manage
              </Link>
            )}
          </div>
          {done && <p className="pl-8 text-sm text-muted-foreground">{summary}</p>}
        </CardHeader>
        {current && <CardContent className="grid gap-4 sm:pl-12">{children}</CardContent>}
      </Card>
    </li>
  );
}

function More({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className={buttonVariants({ variant: 'ghost', className: 'justify-self-start' })}>
      {children}
      <ArrowRight aria-hidden />
    </Link>
  );
}

function Status({ setup, first }: { setup: SetupView | undefined; first: string | undefined }) {
  const { data: view } = useQuery(computerQuery);
  const { data: grants = [] } = useQuery(grantsQuery);
  const { data: syncView } = useQuery(syncQuery);
  const { data: browsers } = useQuery(browsersQuery);
  const stopped = syncView?.disconnected ? 'off' : syncView?.settings?.paused ? 'paused' : null;
  const agents = connectedAgents(grants);
  const sync = setup?.sync;
  const prompts = promptsFor(sync ?? { mode: null, sites: [] });
  return (
    <AppPage title={`Welcome back, ${first}.`}>
      {setup?.noticeOpen && <SetupNotice />}
      {stopped && (
        <Alert>
          <AlertTitle>Browser sync is {stopped}</AlertTitle>
          <AlertDescription>
            Your computer keeps the last copy of your sign-ins.{' '}
            {stopped === 'paused' ? 'Resume from the extension in your browser.' : 'Connect again from the extension.'}
          </AlertDescription>
          <AlertAction>
            <Link href="/app/sync" className={buttonVariants({ size: 'sm', variant: 'secondary' })}>
              Browser sync
            </Link>
          </AlertAction>
        </Alert>
      )}
      {view && <ComputerSummary view={view} />}
      <Card size="sm">
        <CardHeader>
          <CardTitle>
            <h2>Prompt to try</h2>
          </CardTitle>
          <CardDescription>Ask a connected agent:</CardDescription>
        </CardHeader>
        <CardContent>
          <RotatingPrompt prompts={prompts} />
        </CardContent>
      </Card>
      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <p className="text-sm text-muted-foreground">Browser sync</p>
            <SyncTitle view={view} stopped={stopped} />
          </CardHeader>
          <CardContent className="grid gap-3">
            {sync?.mode === 'whole-browser' ? (
              <p className="text-sm text-foreground">All sites, except domains you exclude</p>
            ) : sync?.sites.length ? (
              <ul className="flex flex-wrap gap-1.5" aria-label="Synced sites">
                {siteGroups(sync.sites).map(group => (
                  <li key={group.name}>
                    <Badge variant="secondary">{group.name}</Badge>
                  </li>
                ))}
              </ul>
            ) : null}
            {browsers && (
              <p className="text-sm text-muted-foreground">
                {browsers.browsers.length === 0
                  ? 'No browser connected'
                  : browsers.browsers.length === 1
                    ? '1 browser connected'
                    : `${browsers.browsers.length} browsers connected`}
              </p>
            )}
          </CardContent>
          <CardFooter className="mt-auto">
            <More href="/app/sync">Manage sync</More>
          </CardFooter>
        </Card>
        <Card>
          <CardHeader>
            <p className="text-sm text-muted-foreground">Agents</p>
            <CardTitle>{agents.length ? `${agents.length} connected` : 'None connected'}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="grid text-sm">
              {agents.map(name => (
                <li key={name} className="border-b py-2 last:border-0">
                  {name}
                </li>
              ))}
            </ul>
          </CardContent>
          <CardFooter className="mt-auto">
            <More href="/app/agents">Manage agents</More>
          </CardFooter>
        </Card>
      </div>
    </AppPage>
  );
}

// Shows one prompt at a time, moving to the next every few seconds unless the pointer or focus is on it, so a reader
// can finish or copy the one in view.
function RotatingPrompt({ prompts }: { prompts: string[] }) {
  const [index, setIndex] = useState(0);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (held || prompts.length < 2) return;
    const timer = setInterval(() => setIndex(index => index + 1), 4000);
    return () => clearInterval(timer);
  }, [held, prompts.length]);
  const prompt = prompts[index % prompts.length] ?? '';
  return (
    <section
      aria-label="Suggested prompt"
      className="flex flex-wrap items-center justify-between gap-3 overflow-hidden rounded-lg bg-muted p-4"
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <p key={prompt} className="min-w-0 flex-1 animate-in duration-500 fade-in slide-in-from-bottom-2">
        {prompt}
      </p>
      <CopyButton text={prompt} label="Copy the prompt" />
    </section>
  );
}

function SyncTitle({ view, stopped }: { view: ComputerView | undefined; stopped: 'off' | 'paused' | null }) {
  const synced = view && syncedSignIns(view);
  return (
    <>
      <CardTitle>
        <h2>{stopped === 'off' ? 'Off' : stopped === 'paused' ? 'Paused' : synced ? 'On' : 'Not synced yet'}</h2>
      </CardTitle>
      {synced && (
        <CardDescription>
          Copied {when(synced.copiedAt)} · {synced.applied ? 'on your computer' : 'applied when it next opens'}
        </CardDescription>
      )}
    </>
  );
}

function ComputerSummary({ view }: { view: ComputerView }) {
  const status = computerStatus(view);
  const { usage } = view;
  return (
    <Card>
      <CardHeader>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <span aria-hidden className={`size-2 rounded-full ${status.dot}`} />
          Your computer · {status.short}
        </p>
        <CardTitle>
          <h2>{status.note}</h2>
        </CardTitle>
      </CardHeader>
      {/* Only with an allowance (the metering hook). */}
      {usage && (
        <CardContent className="grid gap-2">
          <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
            <div className="h-full rounded-full bg-foreground" style={{ width: `${usedShare(usage)}%` }} />
          </div>
          <p className="text-sm text-muted-foreground tabular-nums">
            {usage.usedMinutes} of {usage.allowanceMinutes} {usage.name} used this month · resets{' '}
            {resetsOn(usage.resetsAt)}
            {usage.estimate && ` · estimated bill ${usage.estimate}`}
          </p>
        </CardContent>
      )}
      <CardFooter>
        <Link href="/app/computer" className={buttonVariants()}>
          <Eye aria-hidden />
          Live view
        </Link>
      </CardFooter>
    </Card>
  );
}
