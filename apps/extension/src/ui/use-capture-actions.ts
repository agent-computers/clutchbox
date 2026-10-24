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
const serverSite = siteOfHost(new URL(serverOrigin).hostname);
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

// The worker's status and the actions the popup and the setup tab share.
export function useCaptureActions({ onGranted }: { onGranted?: () => void } = {}) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState('');
  const { data: status, isError: unavailable } = useQuery({
    queryKey: statusKey,
    queryFn: () => send({ type: 'status' }),
  });
  // Fetching the account's settings calls the server, so each page does it once on opening.
  useQuery({
    queryKey: checkKey,
    queryFn: async () => {
      const next = await send({ type: 'check' });
      queryClient.setQueryData(statusKey, next);
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
      return send(request);
    },
    onMutate: () => setNotice(''),
    onSuccess: next => queryClient.setQueryData(statusKey, next),
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
                  ? "Couldn't reach Agent Computers. Try again."
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
  const blocked = (site: string) =>
    site === serverSite
      ? 'Agent Computers itself is never synced.'
      : settings?.excludedDomains.some(domain => within(site, domain))
        ? 'This site is excluded.'
        : '';
  const newSites = (site: string) => withCompanions(site, config.companions).filter(each => !sites.includes(each));
  // Both calls start in the click: the message reaches the worker before anyone can answer Chrome's prompt.
  const granted = (origins: string[], prepare: CaptureRequest) => {
    const prepared = chrome.runtime.sendMessage(prepare);
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
  // Grants the click's sites, then opens the server in a tab to connect, unless this browser still has live tokens.
  const connect = (mode: 'sites' | 'all', add: string[] = []) => {
    const origins = mode === 'all' ? [...browserOrigins] : [...sites, ...add].flatMap(siteOrigins);
    if (origins.length) granted(origins, { type: 'prepare', connect: mode, sites: add });
    else run({ type: 'connect', mode });
  };
  // Opens the server in a tab to connect again, without the disclosure or a permission prompt.
  const reconnect = () => run({ type: 'reconnect' });
  // Use added sites only keeps the connection. The worker records added-sites mode and removes the all-sites grant,
  // which takes the added sites' grants with it; requesting them again in the same click restores them without a
  // prompt, since Chrome still records them as granted. Sites it does not restore are listed to allow.
  const addedSitesOnly = () => {
    const origins = sites.flatMap(siteOrigins);
    const restored = (chrome.runtime.sendMessage({ type: 'narrow' }) as Promise<Response>).then(response => {
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
