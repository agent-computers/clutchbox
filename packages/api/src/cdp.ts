import 'server-only';
import { keyCaller } from '@agent-computers/server/api-keys';
import { cdpRelay } from '@agent-computers/server/cdp-relay';
import { CDP_ENDPOINT_MS, CDP_MAX_DURATION_MS, CDP_UPSTREAM_OPEN_MS } from '@agent-computers/server/computer-timing';
import {
  CDP_TOKEN_PATTERN,
  type ComputerFailure,
  type ComputerProvider,
  cdpSessionOf,
  computerSessionState,
  useComputerSession,
} from '@agent-computers/server/computers';
import type { Database } from '@agent-computers/server/database';
import { defaultServerHooks, type ServerHooks } from '@agent-computers/server/hooks';
import { logError } from '@agent-computers/server/log';
import { upgradeWebSocket } from '@vercel/functions';
import { WebSocket } from 'ws';

export { CDP_CLOSE } from '@agent-computers/server/cdp-relay';

// The CDP proxy route: GET /api/v1/cdp?token=<secret>, a WebSocket from a developer's CDP client to the Chrome of the
// fork a REST computer session runs on (POST /api/v1/computers/sessions answers with this URL). Computers stay private:
// Chrome listens only on the computer's loopback, reached through its bridge with the provider's traffic token, which
// never leaves the server. The secret names the session, and the connection acts as the session's API key: the key
// must still have the computers scope, and the session must be open. Everything that can refuse runs before the
// upgrade and answers JSON. Once upgraded, the connection is one call of the session, holding control and keeping the
// fork running, while the relay re-checks the key and the session; it closes with CDP_CLOSE.reconnect just before
// the platform's limit. Never logs messages, URLs, or tokens.

export type CdpDeps = {
  db: Database;
  computers: ComputerProvider;
  hooks?: Pick<ServerHooks, 'metering'> & Partial<Pick<ServerHooks, 'providerAccount'>>;
  // Tests stand in for Vercel's upgrade.
  upgrade?: typeof upgradeWebSocket;
};

const refuse = (error: string, status: number, extra: Record<string, unknown> = {}) =>
  Response.json({ error, ...extra }, { status, headers: { 'Cache-Control': 'private, no-store' } });

// What each computer service refusal answers, here and on the REST routes: no such session, computer, or profile is
// 404; the credit used up, or access revoked, 403; the rest (ended, busy, starting, the user in control) 409.
export const failureStatus = ({ error }: Pick<ComputerFailure, 'error'>) =>
  error === 'session_not_found' || error === 'computer_not_found' || error === 'profile_not_found'
    ? 404
    : error === 'credit_exhausted' || error === 'access_revoked' || error === 'provider_account_refused'
      ? 403
      : 409;
// The refusal's body, in the API key's words where the service's are an MCP agent's.
export const failureBody = ({ error, message, busyUntil, resetsAt }: ComputerFailure) => ({
  error,
  message: error === 'access_revoked' ? 'This API key was deleted, or it does not have the computers scope.' : message,
  ...(busyUntil ? { busyUntil: busyUntil.toISOString() } : {}),
  ...(resetsAt ? { resetsAt: resetsAt.toISOString() } : {}),
});

export function cdpHandler({ db, computers, hooks = defaultServerHooks, upgrade = upgradeWebSocket }: CdpDeps) {
  const running = {
    provider: computers,
    metering: hooks.metering,
    ...(hooks.providerAccount && { accounts: hooks.providerAccount }),
  };
  return async (request: Request): Promise<Response> => {
    // The platform cuts the connection CDP_MAX_DURATION_MS after the function starts.
    const deadlineMs = Date.now() + CDP_MAX_DURATION_MS;
    const token = new URL(request.url).searchParams.get('token');
    if (!token || !CDP_TOKEN_PATTERN.test(token)) return refuse('unauthenticated', 401);
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return refuse('upgrade_required', 426);
    const found = await cdpSessionOf(db, token);
    if (!found) return refuse('session_ended', 409, { message: 'This computer session ended. Open a new one.' });
    const caller = keyCaller(found.member, found.apiKeyId);
    const handle = await useComputerSession(db, running, caller, found.sessionId, {
      budgetMs: deadlineMs - Date.now(),
    });
    if ('error' in handle) return refuse(handle.error, failureStatus(handle), failureBody(handle));
    let upstream: WebSocket;
    try {
      const endpoint = await handle.session.cdpEndpoint(CDP_ENDPOINT_MS);
      upstream = await openUpstream(endpoint.url, endpoint.headers);
    } catch (error) {
      await handle.done();
      logError('cdp connect', error);
      return refuse('computer_unavailable', 503);
    }
    try {
      return await upgrade(client =>
        cdpRelay({
          client,
          upstream,
          access: () => computerSessionState(db, caller, found.sessionId),
          deadlineMs,
        }).then(handle.done),
      );
    } catch (error) {
      upstream.terminate();
      await handle.done();
      throw error;
    }
  };
}

// Chrome's browser endpoint through the computer's bridge, with the provider's traffic token and the Origin the bridge
// expects in the headers (cdpEndpoint()).
function openUpstream(url: string, headers: Record<string, string>) {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers,
      handshakeTimeout: CDP_UPSTREAM_OPEN_MS,
      perMessageDeflate: false,
    });
    const fail = (error: unknown) => {
      socket.terminate();
      reject(error instanceof Error ? error : new Error('cdp upstream closed'));
    };
    socket.once('error', fail);
    socket.once('close', fail);
    socket.once('open', () => {
      socket.off('error', fail);
      socket.off('close', fail);
      // Errors before the relay takes the socket over end it through readyState; the relay logs its own.
      socket.on('error', () => {});
      resolve(socket);
    });
  });
}
