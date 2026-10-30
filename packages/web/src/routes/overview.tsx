import type { Metadata } from 'next';
import { Overview } from '../components/overview';
import { apiOrigin } from '../lib/site';

export const metadata: Metadata = { title: 'Overview · Clutchbox' };
export default function OverviewPage() {
  return <Overview mcpUrl={`${apiOrigin}/api/mcp`} />;
}
