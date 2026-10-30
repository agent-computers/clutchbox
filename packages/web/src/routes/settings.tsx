import type { Metadata } from 'next';
import { Settings } from '../components/settings';
import { apiData, type PageApi, type SignInMethods } from '../lib/page-api';

export const metadata: Metadata = { title: 'Settings · Clutchbox' };
// /app/settings.
export const settingsPage = (api: PageApi) =>
  async function SettingsPage({
    searchParams,
  }: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }) {
    const [methods, { error }] = await Promise.all([apiData<SignInMethods>(api, '/sign-in-methods'), searchParams]);
    return <Settings methods={methods} error={typeof error === 'string' ? error : undefined} />;
  };
