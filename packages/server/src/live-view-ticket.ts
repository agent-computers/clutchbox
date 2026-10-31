import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { LIVE_VIEW_TICKET_MS } from './computer-timing';

// A live-view ticket: how the page opens the relay where its session cookie can't go, at the API's own origin
// (config.ts, apiOrigin), since the cookie is set only for the web app's host. The API signs one for the signed-in
// person's session and this page load's lease (and fork), and the relay route accepts it until it expires. It names the
// session by ID, never its token, so the relay re-checks the session (sessionHolds) but the ticket can't stand in for
// it. Not single-use: within LIVE_VIEW_TICKET_MS it opens only the same page load's relay again, which the lease's watch
// governs as before.
// A paste ticket is the same for live view's image paste, which goes to the API's origin too, since the web app's
// platform may cap request bodies (a Vercel Function at 4.5 MB). Within LIVE_VIEW_TICKET_MS it sets the clipboard only
// while the same page load holds the takeover.
const payloadSchema = z
  .object({
    userId: z.string(),
    sessionId: z.string(),
    lease: z.string(),
    computerId: z.string().optional(),
    exp: z.number(),
  })
  .strict();
export type LiveViewTicket = Omit<z.infer<typeof payloadSchema>, 'exp'>;

// Each use has its own key, derived from the deployment's secret, so a ticket's signature is good for nothing else.
export type TicketUse = 'relay' | 'paste';
const KEYS: Record<TicketUse, string> = { relay: 'live-view-ticket', paste: 'live-view-paste-ticket' };
const sign = (secret: string, use: TicketUse, payload: string) =>
  createHmac('sha256', createHmac('sha256', secret).update(KEYS[use]).digest()).update(payload).digest();

export function signLiveViewTicket(secret: string, ticket: LiveViewTicket, now = Date.now(), use: TicketUse = 'relay') {
  const payload = Buffer.from(JSON.stringify({ ...ticket, exp: now + LIVE_VIEW_TICKET_MS })).toString('base64url');
  return `${payload}.${sign(secret, use, payload).toString('base64url')}`;
}

// The ticket's contents, or null for one that is malformed, altered, expired, or for another use.
export function readLiveViewTicket(
  secret: string,
  value: string | null,
  now = Date.now(),
  use: TicketUse = 'relay',
): LiveViewTicket | null {
  const [payload, signature, extra] = value?.split('.') ?? [];
  if (!payload || !signature || extra !== undefined) return null;
  const expected = sign(secret, use, payload);
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let parsed: z.infer<typeof payloadSchema>;
  try {
    parsed = payloadSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString()));
  } catch {
    return null;
  }
  const { exp, ...ticket } = parsed;
  return exp > now ? ticket : null;
}
