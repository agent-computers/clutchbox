import type { Metadata } from 'next';
import { AgentConnections } from '../components/agent-connections';
import { siteOrigin } from '../lib/site';

export const metadata: Metadata = { title: 'Agents · Clutchbox' };
export default function AgentsPage() {
  return <AgentConnections mcpUrl={`${siteOrigin}/api/mcp`} />;
}
