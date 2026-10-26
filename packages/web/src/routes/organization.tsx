import type { Metadata } from 'next';
import { Organization } from '../components/organization';

export const metadata: Metadata = { title: 'Organization · Clutchbox' };
export default function OrganizationPage() {
  return <Organization />;
}
