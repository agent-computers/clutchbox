import 'server-only';
import { and, desc, eq, isNull, max, ne } from 'drizzle-orm';
import { agentOf, clientHost } from './agents';
import { EXTENSION_CLIENT_ID } from './browsers';
import type { Database } from './database';
import * as schema from './schema';

// The MCP grant. The MCP endpoint and its tools are in packages/api/src/mcp.ts.

export const MCP_SCOPE = 'mcp:tools';
// The scopes agents may request; the extension's `sync` scope is never advertised or granted to them (browsers.ts).
export const MCP_SCOPES = ['openid', 'profile', 'offline_access', MCP_SCOPE];
// email names the account to the agent, so a user can tell which of their accounts it is connected as.
export type McpPrincipal = { userId: string; clientId: string; consentId: string; email: string };
type Claims = { sub?: string; client_id?: unknown; iat?: unknown };

// The grant is the user's consent for one client. It holds while the account is verified and unbanned,
// the client is enabled, and the consent (with the MCP scope) exists. Login sessions are not
// consulted: agent access outlives web sign-in until the user disconnects it. The extension is never an agent: it
// writes no consent (auth.ts refuses prompt=consent for it), and these queries leave it out regardless, so no
// extension token is ever an MCP principal.
const notExtension = ne(schema.oauthConsent.clientId, EXTENSION_CLIENT_ID);
const liveAccount = and(
  eq(schema.user.id, schema.oauthConsent.userId),
  eq(schema.user.emailVerified, true),
  schema.notBanned,
);
const enabledClient = and(
  eq(schema.oauthClient.clientId, schema.oauthConsent.clientId),
  eq(schema.oauthClient.disabled, false),
);
const liveGrant = (db: Pick<Database, 'select'>, userId: string, clientId: string) =>
  db
    .select({
      id: schema.oauthConsent.id,
      scopes: schema.oauthConsent.scopes,
      createdAt: schema.oauthConsent.createdAt,
      email: schema.user.email,
    })
    .from(schema.oauthConsent)
    .innerJoin(schema.user, liveAccount)
    .innerJoin(schema.oauthClient, enabledClient)
    .where(and(eq(schema.oauthConsent.userId, userId), eq(schema.oauthConsent.clientId, clientId), notExtension))
    .orderBy(desc(schema.oauthConsent.createdAt))
    .limit(1);
// Every client's live grant for the user: its latest consent, under the same rules as liveGrant.
async function liveGrants(db: Pick<Database, 'selectDistinctOn'>, userId: string) {
  const latest = await db
    .selectDistinctOn([schema.oauthConsent.clientId], {
      scopes: schema.oauthConsent.scopes,
      createdAt: schema.oauthConsent.createdAt,
    })
    .from(schema.oauthConsent)
    .innerJoin(schema.user, liveAccount)
    .innerJoin(schema.oauthClient, enabledClient)
    .where(and(eq(schema.oauthConsent.userId, userId), notExtension))
    .orderBy(schema.oauthConsent.clientId, desc(schema.oauthConsent.createdAt));
  return latest.filter(grant => grant.scopes.includes(MCP_SCOPE));
}
export async function hasLiveGrant(db: Pick<Database, 'selectDistinctOn'>, userId: string) {
  return (await liveGrants(db, userId)).length > 0;
}
export async function earliestLiveConsentAt(
  db: Pick<Database, 'selectDistinctOn'>,
  userId: string,
): Promise<Date | null> {
  const grants = await liveGrants(db, userId);
  return grants.reduce<Date | null>(
    (earliest, grant) => (!earliest || grant.createdAt < earliest ? grant.createdAt : earliest),
    null,
  );
}

// A valid JWT is necessary, but never sufficient for application access.
export async function liveMcpPrincipal(db: Pick<Database, 'select'>, claims: Claims): Promise<McpPrincipal | null> {
  if (!claims.sub || typeof claims.client_id !== 'string' || typeof claims.iat !== 'number') return null;
  const [grant] = await liveGrant(db, claims.sub, claims.client_id);
  // Tokens issued before this consent belong to a revoked earlier grant and never revive.
  if (!grant?.scopes.includes(MCP_SCOPE) || claims.iat < Math.floor(grant.createdAt.getTime() / 1000)) return null;
  return { userId: claims.sub, clientId: claims.client_id, consentId: grant.id, email: grant.email };
}
export async function grantIsLive(db: Pick<Database, 'select'>, principal: McpPrincipal) {
  const [grant] = await liveGrant(db, principal.userId, principal.clientId);
  return grant?.id === principal.consentId && grant.scopes.includes(MCP_SCOPE);
}

export async function getMcpClientName(db: Database, clientId: string) {
  const [client] = await db
    .select({ name: schema.oauthClient.name })
    .from(schema.oauthClient)
    .where(eq(schema.oauthClient.clientId, clientId));
  return client?.name ?? 'an agent';
}

// One row per connected client: its latest consent. Disabled clients and consents without the MCP
// scope are listed (flagged) so the user can still disconnect them: each can hold refresh tokens.
// lastUsedAt is the client's last call in a computer session on this account, so a connection made
// under the wrong account, one that never uses this computer, stands out.
export async function listMcpGrants(db: Database, userId: string) {
  const used = await db
    .select({ clientId: schema.computerSessions.clientId, lastUsedAt: max(schema.computerSessions.lastCallAt) })
    .from(schema.computerSessions)
    .where(eq(schema.computerSessions.userId, userId))
    .groupBy(schema.computerSessions.clientId);
  const lastUsed = new Map(used.map(row => [row.clientId, row.lastUsedAt]));
  const latest = await db
    .selectDistinctOn([schema.oauthConsent.clientId], {
      id: schema.oauthConsent.id,
      clientId: schema.oauthConsent.clientId,
      name: schema.oauthClient.name,
      disabled: schema.oauthClient.disabled,
      scopes: schema.oauthConsent.scopes,
      createdAt: schema.oauthConsent.createdAt,
    })
    .from(schema.oauthConsent)
    .innerJoin(schema.oauthClient, eq(schema.oauthClient.clientId, schema.oauthConsent.clientId))
    .where(and(eq(schema.oauthConsent.userId, userId), notExtension))
    .orderBy(schema.oauthConsent.clientId, desc(schema.oauthConsent.createdAt));
  return latest
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map(grant => ({
      id: grant.id,
      clientId: grant.clientId,
      host: clientHost(grant.clientId),
      name: grant.name,
      agent: agentOf(grant.clientId),
      disabled: grant.disabled !== false,
      mcp: grant.scopes.includes(MCP_SCOPE),
      scopes: grant.scopes,
      createdAt: grant.createdAt,
      lastUsedAt: lastUsed.get(grant.clientId) ?? null,
    }));
}
// Every agent; connected browsers stay (browsers.ts).
export async function revokeMcpGrants(db: Database, userId: string) {
  await db.transaction(async tx => {
    // Serializes with the access guard (computers.ts), which locks the same row.
    await tx.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.id, userId)).for('update');
    for (const table of [schema.oauthAccessToken, schema.oauthRefreshToken, schema.oauthConsent])
      await tx.delete(table).where(and(eq(table.userId, userId), ne(table.clientId, EXTENSION_CLIENT_ID)));
    // Revoked agents must not keep other agents out of the main computer.
    await tx
      .update(schema.computerSessions)
      .set({ endedAt: new Date(), endReason: 'revoked' })
      .where(and(eq(schema.computerSessions.userId, userId), isNull(schema.computerSessions.endedAt)));
  });
}

// Disconnects one client for this user only; the client itself (shared by every user) stays.
// False when the user never granted it, and always for the extension, whose browsers disconnect on their own.
export async function revokeMcpGrant(db: Database, userId: string, clientId: string) {
  if (clientId === EXTENSION_CLIENT_ID) return false;
  return db.transaction(async tx => {
    // Serializes with the access guard (computers.ts), which locks the same row.
    await tx.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.id, userId)).for('update');
    const [consent] = await tx
      .select({ id: schema.oauthConsent.id })
      .from(schema.oauthConsent)
      .where(and(eq(schema.oauthConsent.userId, userId), eq(schema.oauthConsent.clientId, clientId)))
      .limit(1);
    if (!consent) return false;
    for (const table of [schema.oauthAccessToken, schema.oauthRefreshToken, schema.oauthConsent])
      await tx.delete(table).where(and(eq(table.userId, userId), eq(table.clientId, clientId)));
    await tx
      .update(schema.computerSessions)
      .set({ endedAt: new Date(), endReason: 'revoked' })
      .where(
        and(
          eq(schema.computerSessions.userId, userId),
          eq(schema.computerSessions.clientId, clientId),
          isNull(schema.computerSessions.endedAt),
        ),
      );
    return true;
  });
}
