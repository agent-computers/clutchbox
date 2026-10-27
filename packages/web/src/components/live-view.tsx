/// <reference path="../lib/novnc.d.ts" />
'use client';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@agent-computers/ui/components/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@agent-computers/ui/components/alert-dialog';
import { Button, buttonVariants } from '@agent-computers/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@agent-computers/ui/components/card';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
} from '@agent-computers/ui/components/item';
import { Spinner } from '@agent-computers/ui/components/spinner';
import { ToggleGroup, ToggleGroupItem } from '@agent-computers/ui/components/toggle-group';
import type RFB from '@novnc/novnc';
import { Eye, Maximize, Monitor, MousePointer2 } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type ComputerView,
  type HeartbeatLease,
  type LiveViewStatus,
  useHeartbeat,
  useLiveViewClipboard,
  useLiveViewControl,
} from '../lib/api';
import { resetsOn } from '../lib/computer';
import { chord, decodeCutText, isMac, keyAction, keyQueue, keysymOf, MODIFIER_CODES } from '../lib/live-view-input';
import { agentName } from './agent-connections';
import { useLeaveGuard } from './app-shell';

// Close codes from the relay (RELAY_CLOSE in packages/server/src/live-view-relay.ts): 4000 is its clean close
// before the route's time limit, so reconnect at once; 4001 means this lease lost its watch (hidden too long) or the
// sign-in ended, so wait for a beat that finds it watching; 4002 means the computer must be reset first; 1008 is the
// RFB filter refusing what this page sent, which a retry would repeat. Any other close is a drop, retried with
// backoff while the page is visible.
const RECONNECT_NOW = 4000;
const NOT_WATCHING = 4001;
const NEEDS_RESET = 4002;
const POLICY = 1008;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
// How long a paste shortcut waits for the browser's paste event before reading the clipboard instead: Chrome on macOS
// delivers it through the Edit menu, a round trip after the keydown.
const PASTE_EVENT_MS = 250;
// A paste whose control ended before it finished, or whose connection's input was detached: it shows nothing.
const LOST = Symbol('lost');

// waiting: stopped retrying until a heartbeat finds the page watching while visible.
type Viewer = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'waiting' | 'needsReset' | 'refused' | 'failed';

type Fork = ComputerView['forks'][number];
type Intent = 'watch' | 'control';
// What live view is on: the user's main computer, or an agent's fork of it (computer, its ID), with the name shown.
type Target = { computer?: string | undefined; name: string };
const MAIN: Target = { name: 'Your computer' };
const forkName = (fork: Fork) => fork.label ?? (fork.agent ? `${agentOf(fork.agent)}'s computer` : 'Agent computer');
const agentOf = ({ agent, host }: NonNullable<Fork['agent']>) => (agent ? agentName(agent) : host);

// Live view on the Computer page: noVNC, through our relay, on the user's main computer or one of their agents' forks
// of it. It starts only when the user chooses Watch or Take control, so opening the page neither wakes a computer nor
// uses its time. A session's lease keeps a watch while the page is visible (useHeartbeat), and holds the takeover once
// the user takes control; the relay passes input only while it does, so noVNC's viewOnly only spares the user dead
// input. Stopping, switching computers, or leaving the page releases the lease, which ends the watch and hands back.
// metered: there is a free allowance (the metering hook); exhausted: it is used up (as LiveViewStatus says), until it
// resets. forks: the agents' forks that are not paused. A link with ?computer=<fork ID>, the live-view link the REST API
// gives developers, starts watching that fork.
export function LiveViewPanel({
  metered,
  exhausted,
  forks,
}: {
  metered: boolean;
  exhausted: { resetsAt: string } | null;
  forks: Fork[];
}) {
  const linkedId = useSearchParams().get('computer');
  const linked = forks.find(fork => fork.computerId === linkedId);
  const [session, setSession] = useState<{ intent: Intent; target: Target } | null>(() =>
    linked ? { intent: 'watch', target: { computer: linked.computerId, name: forkName(linked) } } : null,
  );
  const start = (intent: Intent, target: Target) => setSession({ intent, target });
  return (
    <>
      {forks.length > 0 && (
        <AgentComputers
          forks={forks}
          viewing={session ? (session.target.computer ?? null) : undefined}
          exhausted={!!exhausted}
          onStart={start}
        />
      )}
      {session ? (
        <LiveSession
          key={session.target.computer ?? 'main'}
          intent={session.intent}
          target={session.target}
          onStop={() => setSession(null)}
        />
      ) : (
        <LiveViewOff metered={metered} exhausted={exhausted} onStart={intent => start(intent, MAIN)} />
      )}
    </>
  );
}

// The main computer and the agents' running forks of it, each with the agent using it; Watch or Take control moves
// live view to one. viewing: the computer live view is on (null for the main computer), undefined when it is off.
function AgentComputers({
  forks,
  viewing,
  exhausted,
  onStart,
}: {
  forks: Fork[];
  viewing: string | null | undefined;
  exhausted: boolean;
  onStart: (intent: Intent, target: Target) => void;
}) {
  const rows = [
    { target: MAIN, note: "Agents' new computers are copies of it, made when they start.", starting: false },
    ...forks.map(fork => ({
      target: { computer: fork.computerId, name: forkName(fork) },
      note: [
        fork.agent ? agentOf(fork.agent) : 'No agent',
        fork.status === 'starting' ? 'Starting' : fork.status === 'in_use' ? 'Working now' : 'Idle',
      ].join(' · '),
      starting: fork.status === 'starting',
    })),
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Computers</h2>
        </CardTitle>
        <CardDescription>
          Your agents each work on their own copy of your computer. Watch one, or take control to help it past a sign-in
          or a check; the agent waits until you hand back.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ItemGroup className="gap-0">
          {rows.map(({ target, note, starting }, index) => (
            <div key={target.computer ?? 'main'}>
              {index > 0 && <ItemSeparator />}
              <Item className="px-0">
                <ItemContent>
                  <ItemTitle>{target.name}</ItemTitle>
                  <ItemDescription>{note}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  {viewing === (target.computer ?? null) ? (
                    <span className="text-sm text-muted-foreground">In live view</span>
                  ) : (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={exhausted || starting}
                        onClick={() => onStart('watch', target)}
                      >
                        <Eye aria-hidden />
                        Watch
                      </Button>
                      <Button size="sm" disabled={exhausted || starting} onClick={() => onStart('control', target)}>
                        <MousePointer2 aria-hidden />
                        Take control
                      </Button>
                    </>
                  )}
                </ItemActions>
              </Item>
            </div>
          ))}
        </ItemGroup>
      </CardContent>
    </Card>
  );
}

function LiveViewOff({
  metered,
  exhausted,
  onStart,
}: {
  metered: boolean;
  exhausted: { resetsAt: string } | null;
  onStart: (intent: Intent) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Live view</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid min-h-96 place-content-center justify-items-center gap-4 rounded-lg bg-black p-6 text-center ring-1 ring-foreground/10 sm:aspect-[16/10] sm:min-h-0">
          <Monitor aria-hidden className="size-8 text-muted-foreground" />
          <div className="grid gap-1">
            <p className="font-heading text-2xl">Live view is off</p>
            <p className="max-w-sm text-sm text-foreground">
              {exhausted
                ? `This month's free computer minutes are used up, so live view is off until they reset on ${resetsOn(exhausted.resetsAt)}.`
                : 'Take control to sign in to sites on your computer. Your agents work on copies of it, made with its sign-ins.'}
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-3">
            <Button variant="outline" disabled={!!exhausted} onClick={() => onStart('watch')}>
              <Eye aria-hidden />
              Watch
            </Button>
            <Button disabled={!!exhausted} onClick={() => onStart('control')}>
              <MousePointer2 aria-hidden />
              Take control
            </Button>
          </div>
          <p className="max-w-sm text-xs text-muted-foreground">
            Live view wakes your computer, or starts it{metered ? ", and uses free minutes while it's open" : ''}.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function LiveSession({ intent, target, onStop }: { intent: Intent; target: Target; onStop: () => void }) {
  const { computer } = target;
  const fork = !!computer;
  const [lease] = useState(() => crypto.randomUUID());
  const leases = useMemo<HeartbeatLease[]>(() => [{ kind: 'live-view', id: lease, computer }], [lease, computer]);
  const { statusOf, isError, setStatus, updatedAt } = useHeartbeat(leases);
  const status = statusOf('live-view', lease);
  const { takeOver, handBack } = useLiveViewControl(lease, computer, setStatus);
  const clipboard = useLiveViewClipboard(lease, computer);
  const inControl = !!status?.takeover?.mine;
  // The relay accepts this lease only while it holds a live watch or the takeover.
  const connectable = !!status && (status.watching || inControl);
  const viewer = useViewer(lease, computer, connectable, inControl, updatedAt, clipboard.mutateAsync);
  const lapsed = useLapsed(status, handBack.isPending);
  const exhausted = status?.allowanceExhausted;
  // Take control as soon as the first beat answers, when that is what the user chose.
  const asked = useRef(false);
  useEffect(() => {
    if (intent !== 'control' || asked.current || !status || exhausted) return;
    asked.current = true;
    takeOver.mutate();
  }, [intent, status, exhausted, takeOver]);
  const leaving = useLeaveConfirm(inControl, handBack.mutateAsync);
  const box = useRef<HTMLDivElement>(null);

  const mode = inControl ? 'control' : 'watch';
  const switching = takeOver.isPending ? 'control' : handBack.isPending ? 'watch' : null;
  const waiting = inControl ? status?.agentWaiting : null;
  const problem = (takeOver.error ?? handBack.error)?.message ?? viewer.problem;
  return (
    <Card>
      <div
        ref={box}
        className="grid gap-4 [&:fullscreen]:content-start [&:fullscreen]:bg-background [&:fullscreen]:p-4"
      >
        <CardHeader className="flex flex-wrap items-center gap-3">
          <CardTitle className="flex-1">
            <h2>Live view: {target.name}</h2>
          </CardTitle>
          {inControl && (
            <p className="text-sm text-muted-foreground">
              Copy and paste with {mac() ? '⌘C and ⌘V' : 'Ctrl+C and Ctrl+V'}
            </p>
          )}
          {/* A mode the server grants, not a setting: it shows the takeover's state, which can end without a click. */}
          <ToggleGroup
            aria-label="Mode"
            variant="outline"
            spacing={0}
            value={[switching ?? mode]}
            disabled={!status || !!switching}
            onValueChange={([next]) => {
              if (next === 'control' && mode === 'watch') {
                handBack.reset();
                takeOver.mutate();
              }
              if (next === 'watch' && mode === 'control') handBack.mutate();
            }}
          >
            <ToggleGroupItem value="watch">
              {handBack.isPending ? <Spinner aria-hidden /> : <Eye aria-hidden />}
              Watch
            </ToggleGroupItem>
            <ToggleGroupItem value="control" disabled={!!exhausted && !inControl}>
              {takeOver.isPending ? <Spinner aria-hidden /> : <MousePointer2 aria-hidden />}
              Control
            </ToggleGroupItem>
          </ToggleGroup>
          {/* Ending the session releases the lease, which hands back too. */}
          <Button variant="ghost" onClick={onStop}>
            Stop
          </Button>
          <Button
            variant="ghost"
            className="size-11 px-0"
            aria-label="Full screen"
            onClick={() =>
              document.fullscreenElement ? void document.exitFullscreen() : void box.current?.requestFullscreen()
            }
          >
            <Maximize aria-hidden />
          </Button>
        </CardHeader>
        <CardContent className="grid gap-4">
          <p className="text-sm text-foreground" role="status" aria-live="polite">
            {describe({ status, isError, viewer: viewer.state, takingOver: takeOver.isPending, fork })}
          </p>
          {waiting && (
            <Alert>
              <AlertTitle>
                {waiting.agent ? agentName(waiting.agent) : `An agent at ${waiting.host}`} is waiting for your computer
              </AlertTitle>
              <AlertDescription>
                It asked to use it at {time(waiting.since)}. Switch to Watch or stop when you're done, and it carries on
                from here.
              </AlertDescription>
            </Alert>
          )}
          {viewer.state === 'needsReset' && (
            <Alert>
              <AlertTitle>Reset your computer to use live view</AlertTitle>
              <AlertDescription>
                Your computer was made before live view, which needs it to be private. Resetting it deletes sign-ins and
                files made on it.
              </AlertDescription>
              <AlertAction>
                <a href="#reset" className={buttonVariants({ size: 'sm' })}>
                  Go to reset
                </a>
              </AlertAction>
            </Alert>
          )}
          {lapsed && !inControl && (
            <Alert>
              <AlertDescription>
                Your control ended because this page was hidden or offline for over a minute. Switch to Control again to
                continue.
              </AlertDescription>
            </Alert>
          )}
          {exhausted && (
            <Alert variant="destructive">
              <AlertDescription>
                This month's free computer minutes are used up, so live view is off until they reset on{' '}
                {resetsOn(exhausted.resetsAt)}.
              </AlertDescription>
            </Alert>
          )}
          {problem && (
            <Alert variant="destructive">
              <AlertDescription>{problem}</AlertDescription>
            </Alert>
          )}
          <div
            className={`relative aspect-[16/10] w-full overflow-hidden rounded-lg bg-black ${inControl ? 'ring-2 ring-brand' : 'ring-1 ring-foreground/10'}`}
          >
            {/* noVNC owns this element's children. */}
            <div ref={viewer.screen} className="absolute inset-0" />
          </div>
          {inControl && (
            <Alert>
              <AlertTitle>Signing in here</AlertTitle>
              <AlertDescription>
                {fork
                  ? "A sign-in you make here stays on this agent's computer only. To sign in for every agent, take control of your computer instead."
                  : "A sign-in you make here reaches agents' computers made after you hand back. One to a site your browser syncs lasts until that site's sign-in changes in your own browser, or you sign out of it there: the next sync then replaces it. Sign-ins to sites you don't sync stay."}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </div>
      <AlertDialog open={!!leaving.pending} onOpenChange={open => !open && leaving.cancel()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hand back and leave?</AlertDialogTitle>
            <AlertDialogDescription>
              {fork
                ? "You're in control of this agent's computer. Leaving this page hands it back, so the agent carries on."
                : "You're in control of your computer. Leaving this page hands it back, and agents' new computers get what you signed in to."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay</AlertDialogCancel>
            <AlertDialogAction onClick={leaving.confirm}>Hand back and leave</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

// While the user is in control, leaving asks first: in-app links through the app's leave guard, and closing or
// reloading the tab through the browser's own prompt. Confirming hands back, then leaves; a failed hand-back still
// leaves, since the release on unmount ends the takeover too.
function useLeaveConfirm(inControl: boolean, handBack: () => Promise<unknown>) {
  const [pending, setPending] = useState<(() => void) | null>(null);
  const guard = useCallback((leave: () => void) => {
    setPending(() => leave);
    return true;
  }, []);
  useLeaveGuard(inControl ? guard : null);
  useEffect(() => {
    if (!inControl) return;
    const prompt = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', prompt);
    return () => window.removeEventListener('beforeunload', prompt);
  }, [inControl]);
  return {
    pending,
    cancel: () => setPending(null),
    confirm: () => {
      const leave = pending;
      setPending(null);
      void handBack()
        .catch(() => {})
        .finally(() => leave?.());
    },
  };
}

// fork: live view is on an agent's fork rather than the main computer.
function describe({
  status,
  isError,
  viewer,
  takingOver,
  fork,
}: {
  status: LiveViewStatus | undefined;
  isError: boolean;
  viewer: Viewer;
  takingOver: boolean;
  fork: boolean;
}) {
  if (!status) return isError ? 'Live view could not load. Reload to try again.' : 'Loading…';
  // A fork is never created here: one that is gone was deleted, or expired.
  if (status.computer === 'none' && fork) return "This agent's computer was deleted.";
  if (status.computer === 'none')
    return status.allowanceExhausted && !takingOver
      ? "You have no computer yet, and this month's free minutes are used up."
      : 'Starting your computer…';
  if (viewer === 'refused') return 'Live view closed the connection. Reload the page to try again.';
  if (viewer === 'failed') return 'Live view could not start. Reload the page to try again.';
  if (viewer === 'needsReset') return 'Live view needs your computer to be reset first.';
  if (viewer === 'waiting')
    return isError
      ? 'Live view lost touch with the server. Reload the page to try again.'
      : 'Live view is paused. It resumes while this page is visible.';
  if (status.allowanceExhausted && !status.watching) return 'The computer is asleep.';
  if (viewer === 'connecting') return status.computer === 'paused' ? 'Waking the computer…' : 'Connecting…';
  if (viewer === 'reconnecting') return 'Reconnecting…';
  if (status.takeover?.mine)
    return fork
      ? "You're in control. The agent waits until you switch to Watch or stop."
      : "You're in control. Agents keep working on their own computers.";
  if (status.takeover) return "You're in control in another tab. Switch to Control here to move it to this one.";
  if (viewer === 'connected') return 'Watching. Switch to Control to use the mouse and keyboard.';
  return 'Connecting…';
}

const mac = () => typeof navigator !== 'undefined' && isMac(navigator.platform);

const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

// noVNC on this lease's relay connection, to the computer named (a fork's ID; without one, the main computer), while
// it is connectable, reconnecting after drops while the page is visible. viewOnly follows the takeover without reconnecting; the computer's desktop size is fixed for agents, so
// the page never resizes it. beatAt is when the heartbeat last answered. setClipboard sets the computer's clipboard
// for a paste (useLiveViewClipboard); problem is why the last paste failed.
function useViewer(
  lease: string,
  computer: string | undefined,
  connectable: boolean,
  inControl: boolean,
  beatAt: number,
  setClipboard: (text: string) => Promise<unknown>,
) {
  const screen = useRef<HTMLDivElement>(null);
  const client = useRef<RFB | null>(null);
  const control = useRef(inControl);
  // Bumped whenever control changes, so a paste still in flight from before says nothing.
  const epoch = useRef(0);
  const [state, setState] = useState<Viewer>('idle');
  const [problem, setProblem] = useState<string | null>(null);
  const paste = useRef(setClipboard);
  useEffect(() => {
    paste.current = setClipboard;
  }, [setClipboard]);
  // Bumped to start over, with no backoff, once a beat after the viewer stopped finds the page watching.
  const [generation, setGeneration] = useState(0);
  const waitingSince = useRef(0);
  useEffect(() => {
    if (state === 'waiting' && connectable && beatAt > waitingSince.current && !document.hidden)
      setGeneration(next => next + 1);
  }, [state, connectable, beatAt]);
  useEffect(() => {
    control.current = inControl;
    epoch.current += 1;
    setProblem(null);
    if (!client.current) return;
    client.current.viewOnly = !inControl;
    if (inControl) client.current.focus({ preventScroll: true });
  }, [inControl]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: generation is not read inside; a new one restarts the connection.
  useEffect(() => {
    const target = screen.current;
    if (!connectable || !target) return;
    const detachInput = attachInput(target, client, paste, setProblem, epoch);
    let stopped = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = () => {
      waitingSince.current = Date.now();
      setState('waiting');
    };
    const connect = async () => {
      setState(attempt ? 'reconnecting' : 'connecting');
      // noVNC reads window and document as it loads, so it loads here, in the browser, never on the server.
      const { default: RFB } = await import('@novnc/novnc');
      if (stopped) return;
      const url = new URL('/api/v1/live-view', window.location.href);
      url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
      url.searchParams.set('lease', lease);
      if (computer) url.searchParams.set('computer', computer);
      // Opened here rather than by noVNC, to read the close code it does not report.
      const socket = new WebSocket(url, 'binary');
      let code = 0;
      socket.addEventListener('close', event => {
        code = event.code;
      });
      const rfb = new RFB(target, socket, { shared: true });
      rfb.viewOnly = !control.current;
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.background = 'transparent';
      rfb.addEventListener('connect', () => {
        attempt = 0;
        setState('connected');
      });
      // What the computer copies reaches this device's clipboard while the user is in control (noVNC sends no
      // clipboard event in view-only); the browser may refuse without focus, which costs nothing. Empty text is the
      // VNC server's, not a copy.
      rfb.addEventListener('clipboard', event => {
        const text = decodeCutText((event as CustomEvent<{ text: string }>).detail.text);
        if (text) void navigator.clipboard?.writeText(text).catch(() => {});
      });
      rfb.addEventListener('disconnect', () => {
        if (client.current === rfb) client.current = null;
        if (stopped) return;
        if (code === POLICY) return setState('refused');
        if (code === NEEDS_RESET) return setState('needsReset');
        // A hidden page lets its watch lapse, so retrying would only be refused until it shows again.
        if (code === NOT_WATCHING || document.hidden) return wait();
        const delay = code === RECONNECT_NOW ? 0 : BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
        attempt += 1;
        setState('reconnecting');
        timer = setTimeout(() => (document.hidden ? wait() : void connect().catch(fail)), delay);
      });
      client.current = rfb;
    };
    const fail = () => {
      if (!stopped) setState('failed');
    };
    void connect().catch(fail);
    return () => {
      stopped = true;
      detachInput();
      clearTimeout(timer);
      client.current?.disconnect();
      client.current = null;
      setState('idle');
    };
  }, [connectable, lease, computer, generation]);
  return { screen, state, problem };
}

// Keyboard shortcuts and pasting while in control (lib/live-view-input.ts). A capture listener on noVNC's container
// sees each keydown before noVNC's own listener on its canvas, and hides from noVNC the ones the page handles. A paste
// sets the computer's clipboard through our server, because its VNC server takes the clipboard only once and only as
// Latin-1, then presses Ctrl+V there; keys pressed meanwhile wait behind it (keyQueue) and reach noVNC afterwards,
// replayed on its canvas. Returns the cleanup.
function attachInput(
  target: HTMLElement,
  client: { current: RFB | null },
  paste: { current: (text: string) => Promise<unknown> },
  setProblem: (problem: string | null) => void,
  epoch: { current: number },
) {
  const onMac = mac();
  // The modifiers the user holds that noVNC sent, so chords leave them to noVNC.
  const held = new Set<string>();
  let stopped = false;
  // The pastes waiting for the browser's paste event to carry their text, oldest first.
  const takers: ((text: string | null) => void)[] = [];
  const live = () => {
    const rfb = client.current;
    return rfb && !rfb.viewOnly ? rfb : null;
  };
  const queue = keyQueue(error => {
    if (error !== LOST && !stopped) setProblem((error as Error).message);
  });
  const send = (keysym: number, mods: { ctrl: boolean; shift: boolean }) => {
    const rfb = live();
    if (!rfb) return;
    for (const [sym, code, down] of chord(keysym, mods, held)) rfb.sendKey(sym, code, down);
    rfb.focus({ preventScroll: true });
  };
  // Hands a held key event to noVNC in its turn, as a copy this listener lets through (it is not trusted).
  const replay = (type: 'keydown' | 'keyup', event: KeyboardEvent) => {
    const init: KeyboardEventInit = {
      key: event.key,
      code: event.code,
      location: event.location,
      repeat: event.repeat,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      modifierCapsLock: event.getModifierState('CapsLock'),
      modifierNumLock: event.getModifierState('NumLock'),
      bubbles: true,
      cancelable: true,
    };
    return () => {
      if (!live()) return;
      if (type === 'keyup') held.delete(event.code);
      else if (MODIFIER_CODES.has(event.code)) held.add(event.code);
      target.querySelector('canvas')?.dispatchEvent(new KeyboardEvent(type, init));
    };
  };
  const startPaste = (shift: boolean) => {
    const at = epoch.current;
    let take!: (text: string | null) => void;
    const text = new Promise<string | null>(resolve => {
      take = resolve;
    });
    const forget = () => {
      const index = takers.indexOf(taker);
      if (index >= 0) takers.splice(index, 1);
    };
    // Some browsers fire no paste event on a canvas, so read the clipboard after a while instead.
    const timer = setTimeout(() => {
      forget();
      navigator.clipboard.readText().then(take, () => take(null));
    }, PASTE_EVENT_MS);
    const taker = (value: string | null) => {
      clearTimeout(timer);
      forget();
      take(value);
    };
    takers.push(taker);
    queue.push(async () => {
      const current = () => {
        if (stopped || epoch.current !== at || !live()) throw LOST;
      };
      const value = await text;
      current();
      if (value === null) throw new Error('Allow clipboard access for this site to paste on your computer.');
      if (!value) return;
      const failure = await paste.current(value).then(
        () => null,
        (error: Error) => error,
      );
      current();
      if (failure) throw failure;
      setProblem(null);
      send(keysymOf('v', shift), { ctrl: true, shift });
    });
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!event.isTrusted || !live()) return;
    const action = keyAction(event, onMac);
    if (action.kind === 'pass') {
      if (queue.hold('keydown', event.code, replay('keydown', event))) {
        event.stopPropagation();
        event.preventDefault();
      } else if (MODIFIER_CODES.has(event.code)) held.add(event.code);
      return;
    }
    event.stopPropagation();
    if (action.kind === 'send') {
      event.preventDefault();
      queue.push(() => send(action.keysym, action));
    } else if (action.kind === 'paste') {
      // No preventDefault, so the browser fires paste with this device's clipboard.
      startPaste(action.shift);
    }
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (!event.isTrusted) return;
    if (queue.hold('keyup', event.code, replay('keyup', event))) {
      event.stopPropagation();
      event.preventDefault();
    } else held.delete(event.code);
  };
  const onBlur = () => held.clear();
  const onPaste = (event: ClipboardEvent) => {
    const taker = takers[0];
    if (!taker) return;
    event.preventDefault();
    taker(event.clipboardData?.getData('text/plain') ?? '');
  };
  target.addEventListener('keydown', onKeyDown, true);
  target.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', onBlur);
  document.addEventListener('paste', onPaste);
  return () => {
    stopped = true;
    queue.drop();
    for (const taker of [...takers]) taker('');
    target.removeEventListener('keydown', onKeyDown, true);
    target.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('paste', onPaste);
  };
}

// Whether this lease's takeover ended without a hand-back from this page: the page was hidden or offline past the
// lapse, so the server let it go. A takeover moved to another tab shows as that tab's instead, and one that ended
// because the free minutes ran out or the computer was reset has its own message.
function useLapsed(status: LiveViewStatus | undefined, handingBack: boolean) {
  const [lapsed, setLapsed] = useState(false);
  const held = useRef(false);
  useEffect(() => {
    if (status?.takeover?.mine) {
      held.current = true;
      setLapsed(false);
    } else if (held.current && status) {
      held.current = false;
      setLapsed(!status.takeover && !handingBack && !status.allowanceExhausted && status.computer !== 'none');
    }
  }, [status, handingBack]);
  return lapsed;
}
