'use client';
import type { AgentKind } from '@agent-computers/server/agents';
import { Alert, AlertDescription } from '@agent-computers/ui/components/alert';
import { Button } from '@agent-computers/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@agent-computers/ui/components/card';
import { Input } from '@agent-computers/ui/components/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@agent-computers/ui/components/tabs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck } from 'lucide-react';
import { ApiError, api, type Grant, grantsQuery, setupQuery } from '../lib/api';
import { agents } from './agent-steps';
import { AppPage } from './app-shell';
import { CopyButton } from './copy-button';

// A known agent's name, as its tab here shows it (the live view names a waiting agent with it).
export const agentName = (kind: AgentKind) => agents.find(agent => agent.kind === kind)?.name ?? 'Agent';
const otherName = (grant: Grant) => grant.name || 'Agent';
const otherWhere = (grant: Grant) => grant.host ?? grant.clientId;
// A grant the agent can use. Others are still listed so they can be disconnected.
const live = (grant: Grant) => grant.mcp && !grant.disabled;
const status = (grant: Grant) =>
  grant.disabled ? 'Disabled by Agent Computers' : grant.mcp ? 'Connected' : 'Account info only';
// Shows whether the agent uses this account's computer: one connected under another account never does.
const lastUsed = (grant: Pick<Grant, 'lastUsedAt'>) =>
  grant.lastUsedAt
    ? `Last used the computer ${new Date(grant.lastUsedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
    : 'Has not used the computer';

// The agent that last used the computer, by name, and when.
export function lastUser(grants: Grant[]) {
  const [grant] = grants
    .filter(grant => grant.lastUsedAt)
    .sort((a, b) => Date.parse(b.lastUsedAt!) - Date.parse(a.lastUsedAt!));
  return grant ? { name: grant.agent ? agentName(grant.agent) : otherName(grant), at: grant.lastUsedAt! } : null;
}

// Connected agents, named: known agents by name, others with their host.
export function connectedAgents(grants: Grant[]) {
  const connected = grants.filter(live);
  return [
    ...agents.filter(({ kind }) => connected.some(grant => grant.agent === kind)).map(({ name }) => name),
    ...connected.filter(grant => !grant.agent).map(grant => `${otherName(grant)} (${otherWhere(grant)})`),
  ];
}

// The Agents page. Setup is done when a live grant exists. Disconnecting revokes the client's grant for this account
// only.
export function AgentConnections({ mcpUrl }: { mcpUrl: string }) {
  const { data: grants = [], isError } = useQuery(grantsQuery);
  const connect = (
    <Card key="connect">
      <CardHeader>
        <CardTitle>
          <h2>Connect an agent</h2>
        </CardTitle>
        <CardDescription>
          Steps for common agents. Any agent that supports MCP works with the URL above.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="claude-code">
          <TabsList>
            {agents.map(({ kind, name }) => (
              <TabsTrigger key={kind} value={kind}>
                {name}
                {grants.some(grant => grant.agent === kind && live(grant)) && (
                  <>
                    <CircleCheck aria-hidden />
                    <span className="sr-only sm:not-sr-only">Connected</span>
                  </>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
          {agents.map(({ kind, steps }) => (
            <TabsContent key={kind} value={kind} className="pt-3">
              {steps(mcpUrl)}
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  );
  return (
    <AppPage title="Agents" description="Connect Claude, ChatGPT, Codex, or any agent that supports MCP.">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>MCP server URL</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Input id="mcp-url" aria-label="MCP server URL" readOnly value={mcpUrl} className="min-w-60 flex-1" />
          <CopyButton text={mcpUrl} label="Copy the MCP server URL" />
        </CardContent>
      </Card>
      {isError && (
        <Alert variant="destructive">
          <AlertDescription>Your agents could not load. Reload to try again.</AlertDescription>
        </Alert>
      )}
      {grants.length ? [<ConnectedAgents key="connected" grants={grants} />, connect] : connect}
    </AppPage>
  );
}

function ConnectedAgents({ grants }: { grants: Grant[] }) {
  const queryClient = useQueryClient();
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: grantsQuery.queryKey }),
      queryClient.invalidateQueries({ queryKey: setupQuery.queryKey }),
    ]);
  // One agent can hold several clients (Codex registers one per callback), so Disconnect takes them all.
  // A client already gone counts as disconnected.
  const revoke = useMutation({
    mutationFn: (clientIds: string[]) =>
      Promise.all(
        clientIds.map(clientId =>
          api('/mcp/grants/revoke', 'POST', { clientId }).catch(error => {
            if (!(error instanceof ApiError && error.status === 404)) throw error;
          }),
        ),
      ),
    onSettled: refresh,
  });
  const revokeAll = useMutation({ mutationFn: () => api('/mcp/revoke', 'POST'), onSettled: refresh });
  const pending = revoke.isPending || revokeAll.isPending;
  // Known agents as one row each, with every client they registered; others one row per client.
  const rows = [
    ...agents
      .map(({ kind, name }) => ({ name, grants: grants.filter(grant => grant.agent === kind) }))
      .filter(row => row.grants.length),
    ...grants.filter(grant => !grant.agent).map(grant => ({ name: otherName(grant), grants: [grant] })),
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Connected</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <ul className="text-sm">
          {rows.map(row => {
            const used = lastUser(row.grants);
            return (
              <li
                key={row.grants[0]!.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b py-2 last:border-0"
              >
                <span className="grid min-w-0">
                  <span>{row.name}</span>
                  <span className="break-all text-muted-foreground">
                    {row.grants.map(grant => `${status(grant)} · ${otherWhere(grant)}`).join(', ')}
                  </span>
                  {row.grants.some(live) && (
                    <span className="text-muted-foreground">
                      {used ? lastUsed({ lastUsedAt: used.at }) : lastUsed({ lastUsedAt: null })}
                    </span>
                  )}
                </span>
                <Button
                  variant="ghost"
                  aria-label={
                    row.grants[0]!.agent
                      ? `Disconnect ${row.name}`
                      : `Disconnect ${row.name} (${otherWhere(row.grants[0]!)})`
                  }
                  disabled={pending}
                  onClick={() => {
                    revokeAll.reset();
                    revoke.mutate(row.grants.map(grant => grant.clientId));
                  }}
                >
                  Disconnect
                </Button>
              </li>
            );
          })}
        </ul>
        <div>
          <Button
            variant="secondary"
            disabled={pending}
            onClick={() => {
              revoke.reset();
              revokeAll.mutate();
            }}
          >
            {revokeAll.isPending ? 'Disconnecting…' : 'Disconnect all agents'}
          </Button>
        </div>
        {(revoke.isError || revokeAll.isError) && (
          <Alert variant="destructive">
            <AlertDescription>Disconnection failed. Please try again.</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
