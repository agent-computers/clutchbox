import {
  browserOrigins,
  type CaptureRequest,
  defaultExtensionConfig,
  type Response,
  siteOfHost,
  siteOrigins,
  withCompanions,
  within,
} from '@agent-computers/capture';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { pendingKey, pendingTtlMs } from '../controller';
import { serverOrigin } from '../server';
import { send } from './send';

export const statusKey = ['status'];
const checkKey = ['check'];
const pendingQueryKey = ['pending'];
const siteOf = (origin: string) => siteOfHost(new URL(origin).hostname);
class NotGranted extends Error {}
type Action = { request: CaptureRequest; permission?: Promise<boolean>; prepared?: Promise<unknown> };

// When a click waiting for Chrome's prompt, from this page or another one, expires; 0 without one.
// A second prompt would replace it.
async function pendingUntil() {
  const pending = (await chrome.storage.session.get(pendingKey))[pendingKey] as { at: number } | undefined;
  const until = pending ? pending.at + pendingTtlMs : 0;
  return until > Date.now() ? until : 0;
}
// Shown while such a click holds every grant button: one closed with the popup (macOS) clears only when it expires.
export const pendingMessage =
  "Waiting for your answer to the browser's access prompt. If it closed, try again in two minutes.";

// Another server to connect to, and whether the person agreed to its warning.
export type ServerChoice = { origin: string; warned?: true };
// The worker's status and the actions the popup and the setup tab share, for one connection: `connection`, or the one
// the popup showed last without one. With `another`, connecting signs in to a server, the build's or `server`.
export function useCaptureActions({
  connection,
  another = false,
  server,
  onGranted,
}: {
  connection?: string | undefined;
  another?: boolean;
  server?: ServerChoice | undefined;
  onGranted?: () => void;
} = {}) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState('');
  const scoped = (request: CaptureRequest): CaptureRequest =>
    request.type === 'finish' || request.type === 'exchange' || request.type === 'server'
      ? request
      : another && (request.type === 'connect' || request.type === 'prepare')
        ? { ...request, another: true, ...server }
        : connection
          ? { ...request, connection }
          : request;
  const key = [...statusKey, connection ?? null];
  const { data: status, isError: unavailable } = useQuery({
    queryKey: key,
    queryFn: () => send(scoped({ type: 'status' })),
  });
  // Fetching the accounts' settings calls the servers, so each page does it once on opening.
  useQuery({
    queryKey: checkKey,
    queryFn: async () => {
      const next = await send(scoped({ type: 'check' }));
      queryClient.setQueryData(key, next);
      return next;
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
  // Nothing is written when a pending click expires, so read it again once it has.
  const { data: until = 0 } = useQuery({
    queryKey: pendingQueryKey,
    queryFn: pendingUntil,
    refetchInterval: query => (query.state.data ? Math.max(query.state.data - Date.now(), 0) + 50 : false),
  });
  const pending = until > 0;
  // Every action answers with the new status. Chrome's permission prompt must start in the click itself, so callers
  // pass it in, after telling the worker what the click is for: the prompt can close the popup, and the worker
  // then finishes it when the grant arrives.
  const action = useMutation({
    mutationFn: async ({ request, permission, prepared }: Action) => {
      if (permission && !(await permission)) {
        // Nothing will finish a refused click, so it stops holding up the others. The worker may still be
        // writing it behind other work, so wait for that first.
        if (prepared) {
          await prepared.catch(() => {});
          await chrome.storage.session.remove(pendingKey);
        }
        throw new NotGranted();
      }
      return send(scoped(request));
    },
    onMutate: () => setNotice(''),
    onSuccess: next => queryClient.setQueryData(key, next),
    onError: error => {
      setNotice(
        error instanceof NotGranted
          ? 'Access was not granted. Nothing was captured.'
          : error.message === 'excluded'
            ? 'That site is excluded. Remove the exclusion on your account page first.'
            : error.message === 'reconnect'
              ? 'This browser needs to reconnect first.'
              : error.message === 'expired'
                ? 'That connection attempt expired. Try again.'
                : error.message === 'unavailable'
                  ? "Couldn't reach the server. Try again."
                  : error.message === 'unverified_server'
                    ? 'That server needs your agreement to its warning first.'
                    : 'Operation did not finish. Check browser access and try again.',
      );
      return queryClient.invalidateQueries({ queryKey: statusKey });
    },
  });
  const run = (request: CaptureRequest) => action.mutate({ request });
  const busy = action.isPending;

  useEffect(() => {
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: statusKey });
      void queryClient.invalidateQueries({ queryKey: pendingQueryKey });
    };
    chrome.permissions.onRemoved.addListener(refresh);
    chrome.storage.onChanged.addListener(refresh);
    return () => {
      chrome.permissions.onRemoved.removeListener(refresh);
      chrome.storage.onChanged.removeListener(refresh);
    };
  }, [queryClient]);

  const settings = status?.settings;
  const sites = settings?.sites ?? [];
  // The server's suggested sites and related domains, or the built-in ones until the worker has them.
  const config = status?.config ?? defaultExtensionConfig;
  // No connection's server site is synced.
  const serverSites = [status?.origin ?? serverOrigin, ...(status?.connections ?? []).map(each => each.origin)].map(
    siteOf,
  );
  const blocked = (site: string) =>
    serverSites.includes(site)
      ? 'Clutchbox itself is never synced.'
      : settings?.excludedDomains.some(domain => within(site, domain))
        ? 'This site is excluded.'
        : '';
  const newSites = (site: string) => withCompanions(site, config.companions).filter(each => !sites.includes(each));
  // Both calls start in the click: the message reaches the worker before anyone can answer Chrome's prompt.
  const granted = (origins: string[], prepare: CaptureRequest) => {
    const prepared = chrome.runtime.sendMessage(scoped(prepare));
    action.mutate(
      { request: { type: 'finish' }, permission: chrome.permissions.request({ origins }), prepared },
      { onSuccess: () => onGranted?.() },
    );
  };
  const addSites = (added: string[]) => granted(added.flatMap(siteOrigins), { type: 'prepare', sites: added });
  // Removes a site and the companions that name it back, which share its sign-in (x.com and twitter.com). A one-way
  // companion stays: removing youtube.com keeps google.com. The worker revokes their grants and the server deletes
  // their uploaded copy.
  const removeSite = (site: string) => {
    const removed = withCompanions(site, config.companions).filter(
      each => each === site || config.companions[each]?.includes(site),
    );
    run({ type: 'sites', sites: sites.filter(each => !removed.includes(each)) });
  };
  // Grants the click's sites, then opens the server in a tab to connect, unless the connection still has live tokens.
  const connect = (mode: 'sites' | 'all', add: string[] = []) => {
    const origins = mode === 'all' ? [...browserOrigins] : [...(another ? [] : sites), ...add].flatMap(siteOrigins);
    if (origins.length) granted(origins, { type: 'prepare', connect: mode, sites: add });
    else run({ type: 'connect', mode });
  };
  // Opens the server in a tab to connect again, without the disclosure or a permission prompt.
  const reconnect = () => run({ type: 'reconnect' });
  // Use added sites only keeps the connection. The worker records added-sites mode and removes the all-sites grant,
  // which takes every connection's added sites' grants with it; requesting them again in the same click restores them
  // without a prompt, since Chrome still records them as granted. Sites it does not restore are listed to allow.
  const addedSitesOnly = () => {
    const every = [sites, ...(status?.connections ?? []).map(each => each.settings.sites)].flat();
    const origins = [...new Set(every)].flatMap(siteOrigins);
    const restored = (chrome.runtime.sendMessage(scoped({ type: 'narrow' })) as Promise<Response>).then(response => {
      if (!response.ok) throw new Error(response.error);
      return origins.length ? chrome.permissions.request({ origins }).catch(() => false) : true;
    });
    action.mutate({ request: { type: 'capture' }, permission: restored.then(() => true) });
  };
  return {
    status,
    config,
    unavailable,
    notice,
    setNotice,
    action,
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
  };
}
