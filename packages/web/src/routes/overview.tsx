import type { Metadata } from 'next';
import { Overview } from '../components/overview';
import { siteOrigin } from '../lib/site';

export const metadata: Metadata = { title: 'Overview · Agent Computers' };
export default function OverviewPage() {
  return <Overview mcpUrl={`${siteOrigin}/api/mcp`} />;
}
