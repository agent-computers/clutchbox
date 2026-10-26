import type { SyncChange, SyncSettings } from '@agent-computers/capture';
import type { AgentKind } from '@agent-computers/server/agents';
import type { ConnectedBrowser } from '@agent-computers/server/browsers';
import { HEARTBEAT_MS } from '@agent-computers/server/computer-timing';
import type { LiveViewStatus } from '@agent-computers/server/computers';
import type { Role } from '@agent-computers/server/members';
import { type QueryClient, queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

export type ComputerView = {
  // Null without a free allowance (the metering hook).
  usage: { usedMinutes: number; allowanceMinutes: number; resetsAt: string } | null;
  capture: { completedAt: string; uploadedAt: string; cookieCount: number } | null;
  computer: { status: string; busy: boolean; inLiveView: boolean; appliedCaptureAt: string | null } | null;
};
// One connected client. `agent` is known only from its client_id URL; `host` is where that URL points.
export type Grant = {
  id: string;
  clientId: string;
  host: string | null;
  name: string | null;
  agent: AgentKind | null;
  disabled: boolean;
  // False for a client that holds only account info (no MCP scope): listed so it can be disconnected.
  mcp: boolean;
  createdAt: string;
  // The client's last call on this account's computer; null if it never used it.
  lastUsedAt: string | null;
};
export type SetupView = {
  setUpAt: string | null;
  noticeOpen: boolean;
  items: { browserSync: boolean; agents: boolean; computer: boolean };
  sync: { mode: 'sites' | 'whole-browser' | null; sites: string[]; readable: boolean };
};
// A browser connected with OAuth; browser and platform are null when its User-Agent did not say.
export type Browser = Omit<ConnectedBrowser, 'connectedAt' | 'lastSyncedAt'> & {
  connectedAt: string;
  lastSyncedAt: string | null;
};
// The account's browser sync settings; null until an extension adopts them.
export type SyncView = { settings: SyncSettings | null; disconnected: boolean };
export type { Role, SyncChange };
// The organization the app acts in, who is in it, and your role there.
export type OrganizationView = {
  organization: { id: string; name: string; personal: boolean; joinDomains: string[] };
  role: Role;
  members: { id: string; name: string; email: string; role: Role; joinedAt: string; you: boolean }[];
};
export type Invitation = { id: string; role: Role; createdAt: string; expiresAt: string; invitedBy: string | null };
// An organization you may join because it allows your email address's domain.
export type JoinableOrganization = { id: string; name: string };

// Calls /api/v1 and throws the server's message, or a generic one, so callers can show error.message. The error
// carries the server's error code too, for callers that word it themselves.
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method,
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new ApiError(
      response.status,
      data.error,
      data.message ||
        (data.error === 'invalid_request'
          ? 'Enter a full web address, like https://mail.google.com.'
          : 'Something went wrong. Please try again.'),
    );
  return data;
}
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

export const computerQuery = queryOptions({ queryKey: ['computer'], queryFn: () => api<ComputerView>('/computer') });
export const grantsQuery = queryOptions({
  queryKey: ['mcp', 'grants'],
  queryFn: () => api<{ grants: Grant[] }>('/mcp/grants'),
  select: data => data.grants,
});
export const setupQuery = queryOptions({ queryKey: ['setup'], queryFn: () => api<SetupView>('/setup') });
export const syncQuery = queryOptions({ queryKey: ['sync'], queryFn: () => api<SyncView>('/sync') });
export type BrowsersView = { browsers: Browser[] };
export const browsersQuery = queryOptions({
  queryKey: ['browsers'],
  queryFn: () => api<BrowsersView>('/browsers'),
});
export const organizationQuery = queryOptions({
  queryKey: ['organization'],
  queryFn: () => api<OrganizationView>('/organization'),
});
export const invitationsQuery = queryOptions({
  queryKey: ['organization', 'invitations'],
  queryFn: () => api<{ invitations: Invitation[] }>('/organization/invitations'),
  select: data => data.invitations,
});
export const joinableQuery = queryOptions({
  queryKey: ['organizations', 'joinable'],
  queryFn: () => api<{ organizations: JoinableOrganization[] }>('/organizations/joinable'),
  select: data => data.organizations,
});

// --- Heartbeat ---
// Each kind of lease a page can hold, and the status its handler answers with (packages/server/src/heartbeat.ts).
export type { LiveViewStatus };

type HeartbeatStatuses = { 'live-view': LiveViewStatus };
export type HeartbeatKind = keyof HeartbeatStatuses;
export type HeartbeatLease = { kind: HeartbeatKind; id: string };
type HeartbeatState = 'visible' | 'hidden' | 'released';
type HeartbeatResponse = { leases: { kind: HeartbeatKind; id: string; status: unknown }[] };

const heartbeatKey = (leases: HeartbeatLease[]) => ['heartbeat', ...leases.map(({ kind, id }) => `${kind}:${id}`)];
const heartbeatBody = (leases: HeartbeatLease[], state: HeartbeatState) => ({
  leases: leases.map(({ kind, id }) => ({ kind, id, state })),
});

// Keeps the page's leases alive: a beat every HEARTBEAT_MS while the page is visible (TanStack Query pauses the
// interval while the document is hidden, and beats again when it shows), one beat when it is hidden, and a keepalive
// release on pagehide or unmount, which ends the leases at once; the server then ignores their beats for a while. An
// unmount's release waits a tick, so React's development remount (StrictMode) cancels it rather than end leases the
// page still holds. Returns each lease's latest status, by kind, and when the last beat answered.
export function useHeartbeat(leases: HeartbeatLease[]) {
  const queryClient = useQueryClient();
  const pendingRelease = useRef<{ key: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const queryKey = heartbeatKey(leases);
  const keyString = queryKey.join(' ');
  const query = useQuery({
    queryKey,
    queryFn: () =>
      api<HeartbeatResponse>(
        '/heartbeat',
        'POST',
        heartbeatBody(leases, document.visibilityState === 'visible' ? 'visible' : 'hidden'),
      ),
    refetchInterval: HEARTBEAT_MS,
    refetchOnWindowFocus: 'always',
    // The next beat is the retry.
    retry: false,
    gcTime: 0,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyString stands for the leases by content, so a caller's new array with the same leases changes nothing.
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === 'hidden') void queryClient.refetchQueries({ queryKey, exact: true });
    };
    // Sent with keepalive so it outlives the page; nothing reads the answer.
    const release = () =>
      void fetch('/api/v1/heartbeat', {
        method: 'POST',
        keepalive: true,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(heartbeatBody(leases, 'released')),
      }).catch(() => {});
    if (pendingRelease.current?.key === keyString) clearTimeout(pendingRelease.current.timer);
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', release);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', release);
      pendingRelease.current = { key: keyString, timer: setTimeout(release) };
    };
  }, [keyString, queryClient]);
  const statusOf = <K extends HeartbeatKind>(kind: K, id: string) =>
    query.data?.leases.find(lease => lease.kind === kind && lease.id === id)?.status as
      | HeartbeatStatuses[K]
      | undefined;
  return {
    statusOf,
    isError: query.isError,
    updatedAt: query.dataUpdatedAt,
    setStatus: setHeartbeatStatus(queryClient, queryKey),
  };
}
// Puts a lease status a mutation answered with into the heartbeat's data, so the page shows it before the next beat.
// A beat still in flight was sent before the change, so it is dropped rather than let it show the old status.
type SetStatus = <K extends HeartbeatKind>(kind: K, id: string, status: HeartbeatStatuses[K]) => Promise<void>;
const setHeartbeatStatus =
  (queryClient: QueryClient, queryKey: string[]): SetStatus =>
  async (kind, id, status) => {
    await queryClient.cancelQueries({ queryKey, exact: true });
    queryClient.setQueryData<HeartbeatResponse>(queryKey, data => ({
      leases: data
        ? data.leases.map(lease => (lease.kind === kind && lease.id === id ? { ...lease, status } : lease))
        : [{ kind, id, status }],
    }));
  };

// Take control for this page load's lease, or hand back. Each answers with the lease's live view status.
export function useLiveViewControl(lease: string, setStatus: SetStatus) {
  return {
    takeOver: useLeaseMutation('/computer/takeover', lease, setStatus),
    handBack: useLeaseMutation('/computer/hand-back', lease, setStatus),
  };
}
function useLeaseMutation(path: string, lease: string, setStatus: SetStatus) {
  return useMutation({
    mutationFn: () => api<LiveViewStatus>(path, 'POST', { lease }),
    onSuccess: status => setStatus('live-view', lease, status),
  });
}

// Sets the computer's clipboard to text, for pasting there, while this lease holds the takeover (POST
// /computer/clipboard). Its errors carry a message to show.
export function useLiveViewClipboard(lease: string) {
  return useMutation({
    mutationFn: (text: string) =>
      api<Record<string, never>>('/computer/clipboard', 'POST', { lease, text }).catch(error => {
        const status = error instanceof ApiError ? error.status : 0;
        throw new Error(
          status === 413
            ? 'Your clipboard holds more text than live view can paste (1 MB).'
            : status === 409
              ? 'Switch to Control to paste on your computer.'
              : 'Your clipboard could not reach your computer. Try again.',
        );
      }),
  });
}
