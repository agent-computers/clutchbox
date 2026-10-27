import type { Metadata } from 'next';
import { Developers } from '../components/developers';

export const metadata: Metadata = { title: 'Developers · Clutchbox' };
export default function DevelopersPage() {
  return <Developers />;
}
