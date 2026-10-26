import { signInMethods } from '@agent-computers/server/config';
import type { Metadata } from 'next';
import { Settings } from '../components/settings';
import type { GetServices } from '../services';

export const metadata: Metadata = { title: 'Settings · Clutchbox' };
// /app/settings.
export const settingsPage = (getServices: GetServices) =>
  async function SettingsPage({
    searchParams,
  }: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }) {
    const [{ config }, { error }] = await Promise.all([getServices(), searchParams]);
    return <Settings methods={signInMethods(config)} error={typeof error === 'string' ? error : undefined} />;
  };
