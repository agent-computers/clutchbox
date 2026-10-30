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

// Its own key, derived from the deployment's secret, so a ticket's signature is good for nothing else.
const sign = (secret: string, payload: string) =>
  createHmac('sha256', createHmac('sha256', secret).update('live-view-ticket').digest()).update(payload).digest();

export function signLiveViewTicket(secret: string, ticket: LiveViewTicket, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ ...ticket, exp: now + LIVE_VIEW_TICKET_MS })).toString('base64url');
  return `${payload}.${sign(secret, payload).toString('base64url')}`;
}

// The ticket's contents, or null for one that is malformed, altered, or expired.
export function readLiveViewTicket(secret: string, value: string | null, now = Date.now()): LiveViewTicket | null {
  const [payload, signature, extra] = value?.split('.') ?? [];
  if (!payload || !signature || extra !== undefined) return null;
  const expected = sign(secret, payload);
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
