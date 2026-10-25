// Known agents by OAuth client_id. Agents identify with a client metadata document (CIMD), so the
// client_id is the document's URL and the vendor's host vouches for it. The client's name is
// self-asserted and never classifies a client. Anything not listed here is an "Other agent".
export type AgentKind = 'claude-code' | 'claude' | 'codex' | 'chatgpt';
export const agentClients: Record<AgentKind, readonly string[]> = {
  'claude-code': ['https://claude.ai/oauth/claude-code-client-metadata'],
  claude: ['https://claude.ai/oauth/mcp-oauth-client-metadata'],
  codex: ['https://chatgpt.com/oauth/codex/client.json'],
  chatgpt: ['https://chatgpt.com/oauth/client.json'],
};
// Codex also serves one document per local callback.
const codexCallbackClient = /^https:\/\/chatgpt\.com\/oauth\/codex\/[A-Za-z0-9_-]+\/client\.json$/;

export function agentOf(clientId: string): AgentKind | null {
  for (const [kind, clientIds] of Object.entries(agentClients) as [AgentKind, readonly string[]][])
    if (clientIds.includes(clientId)) return kind;
  return codexCallbackClient.test(clientId) ? 'codex' : null;
}
// The host a client_id URL names, shown so the user sees where a connection really points.
export function clientHost(clientId: string): string | null {
  try {
    return new URL(clientId).host || null;
  } catch {
    return null;
  }
}
