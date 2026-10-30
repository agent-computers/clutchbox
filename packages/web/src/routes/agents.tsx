import type { Metadata } from 'next';
import { AgentConnections } from '../components/agent-connections';
import { apiOrigin } from '../lib/site';

export const metadata: Metadata = { title: 'Agents · Clutchbox' };
export default function AgentsPage() {
  return <AgentConnections mcpUrl={`${apiOrigin}/api/mcp`} />;
}
