import { describe, expect, it } from 'vitest';
import { agentOf, builtInAgentClientUrls, clientHost, isAllowedAgentClient } from './agents';

describe('agent classification', () => {
  it('matches known client_id URLs exactly and leaves everything else as another agent', () => {
    expect(agentOf('https://claude.ai/oauth/claude-code-client-metadata')).toBe('claude-code');
    expect(agentOf('https://claude.ai/oauth/mcp-oauth-client-metadata')).toBe('claude');
    expect(agentOf('https://chatgpt.com/oauth/client.json')).toBe('chatgpt');
    expect(agentOf('https://chatgpt.com/oauth/codex/client.json')).toBe('codex');
    expect(agentOf('https://chatgpt.com/oauth/codex/cb_1234-x/client.json')).toBe('codex');
    for (const near of [
      'https://claude.ai/oauth/claude-code-client-metadata/',
      'https://claude.ai/oauth/claude-code-client-metadata?x=1',
      'http://claude.ai/oauth/mcp-oauth-client-metadata',
      'https://claude.ai.evil.test/oauth/mcp-oauth-client-metadata',
      'https://evil.test/https://chatgpt.com/oauth/client.json',
      'https://chatgpt.com/oauth/codex/a/b/client.json',
      'https://chatgpt.com/oauth/codex/../client.json',
      'https://chatgpt.com/oauth/codex/x/client.json.evil.test',
      'browser-fixture-0d4f',
    ])
      expect(agentOf(near), near).toBeNull();
  });
  it("allows the agents' own client_id URLs and the deployment's, and nothing that only looks like them", () => {
    const urls = [...builtInAgentClientUrls, 'https://agents.example.test/clients/', 'https://one.example.test/c.json'];
    for (const allowed of [
      'https://claude.ai/oauth/mcp-oauth-client-metadata',
      'https://claude.ai/oauth/claude-code-client-metadata',
      'https://chatgpt.com/oauth/client.json',
      'https://chatgpt.com/oauth/cb_1234-x/client.json',
      'https://chatgpt.com/oauth/codex/client.json',
      'https://chatgpt.com/oauth/codex/cb_1234-x/client.json',
      'https://agents.example.test/clients/a.json',
      'https://one.example.test/c.json',
    ])
      expect(isAllowedAgentClient(allowed, urls), allowed).toBe(true);
    for (const refused of [
      'https://evil.test/oauth/mcp-oauth-client-metadata',
      'https://claude.ai.evil.test/oauth/mcp-oauth-client-metadata',
      'https://evil.test/https://claude.ai/oauth/mcp-oauth-client-metadata',
      'http://claude.ai/oauth/mcp-oauth-client-metadata',
      'https://claude.ai:8443/oauth/mcp-oauth-client-metadata',
      'https://user@claude.ai/oauth/mcp-oauth-client-metadata',
      'https://claude.ai/oauth/mcp-oauth-client-metadata?x=1',
      'https://claude.ai/oauth/mcp-oauth-client-metadata#x',
      'https://claude.ai/api/client.json',
      'https://claude.ai/oauth',
      'https://claude.ai/oauth/../u/doc.json',
      'https://claude.ai/oauth/%2e%2e/u/doc.json',
      'https://CLAUDE.ai/oauth/mcp-oauth-client-metadata',
      'https://one.example.test/c.json/x',
      'https://agents.example.test/clientsx/a.json',
      'browser-fixture-0d4f',
    ])
      expect(isAllowedAgentClient(refused, urls), refused).toBe(false);
  });
  it('reports the host a client_id URL names, or null for other IDs', () => {
    expect(clientHost('https://claude.ai/oauth/mcp-oauth-client-metadata')).toBe('claude.ai');
    expect(clientHost('https://client.example.test:8443/c.json')).toBe('client.example.test:8443');
    expect(clientHost('browser-fixture-0d4f')).toBeNull();
    expect(clientHost('urn:example:client')).toBeNull();
  });
});
