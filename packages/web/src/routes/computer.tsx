import type { Metadata } from 'next';
import { AgentComputer } from '../components/agent-computer';

export const metadata: Metadata = { title: 'Your computer · Clutchbox' };
export default function ComputerPage() {
  return <AgentComputer />;
}
