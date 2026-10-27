// Known agents by OAuth client_id. Agents identify with a client metadata document (CIMD), so the
// client_id is the document's URL and the vendor's host vouches for it. The client's name is
// self-asserted and never classifies a client. Anything not listed here, such as an agent the
// deployment allows (AGENT_CLIENT_URLS), is an "Other agent".
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
// The client_id URLs an agent may connect with. Any site can publish a client metadata document named "Claude", so
// an open list lets it phish a consent for the member's signed-in computer. Claude, Claude Code, ChatGPT, and Codex
// serve theirs under these paths, including Claude's undocumented hosted URL and the per-callback forms, so a prefix
// keeps a variant we haven't seen working. The deployment adds others (AGENT_CLIENT_URLS, agentClientUrls in config.ts).
// The check runs again at every refresh after the metadata cache expires, so a URL dropped here disconnects its agent.
export const builtInAgentClientUrls = ['https://claude.ai/oauth/', 'https://chatgpt.com/oauth/'] as const;

// Whether a client_id is one of the URLs: the same origin, and the same path, or under one that ends with a slash. The
// URL must already be in its normalized form, so an encoded dot segment or an odd spelling never slips past a prefix.
export function isAllowedAgentClient(clientId: string, urls: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return false;
  }
  if (url.href !== clientId || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    return false;
  return urls.some(entry => {
    const allowed = new URL(entry);
    return (
      url.origin === allowed.origin &&
      (url.pathname === allowed.pathname ||
        (allowed.pathname.endsWith('/') && url.pathname.startsWith(allowed.pathname)))
    );
  });
}

// The host a client_id URL names, shown so the user sees where a connection really points.
export function clientHost(clientId: string): string | null {
  try {
    return new URL(clientId).host || null;
  } catch {
    return null;
  }
}
