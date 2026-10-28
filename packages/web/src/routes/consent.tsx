import { verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import type { OAuthScopeMetadataMap } from '@better-auth-ui/core/plugins/oauth-provider';
import { getPrincipal } from '@clutchbox/server/auth';
import { CONNECT_SCOPE, connectApp } from '@clutchbox/server/connect';
import { organizationsOf } from '@clutchbox/server/organizations';
import { APIError } from 'better-auth/api';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { OAuthConsent } from '../components/oauth-consent';
import type { GetServices } from '../services';

export const metadata: Metadata = { robots: { index: false } };
const scopeMetadata: OAuthScopeMetadataMap = {
  openid: { label: 'Identify your account' },
  profile: { label: 'Read your basic account profile' },
  offline_access: { label: 'Stay connected until access expires or you disconnect' },
  'mcp:tools': {
    label: 'Fully control your Clutchbox computer',
    description:
      'See the screen, click, type, run commands, and act as you on every site signed in there. Only one agent controls it at a time.',
  },
};
const hostOf = (value: string | null) => {
  try {
    return value ? new URL(value).host : null;
  } catch {
    return null;
  }
};
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const page = 'mx-auto w-full max-w-xl px-5 py-6 sm:px-8';
function InvalidRequest() {
  return (
    <main id="main" className={page}>
      <h1 className="font-heading text-4xl leading-tight font-medium">Connection request expired or invalid.</h1>
      <p className="mt-3 text-foreground">Start the connection again from your agent.</p>
    </main>
  );
}
// /consent: an agent asks to connect.
export const consentPage = (getServices: GetServices) =>
  async function Consent({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
    const params = await searchParams;
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params))
      for (const entry of Array.isArray(value) ? value : value ? [value] : []) query.append(key, entry);
    const { auth, config, db } = await getServices();
    const oauthQuery = query.toString();
    const valid = await verifyOAuthQueryParams(oauthQuery, config.BETTER_AUTH_SECRET);
    if (!valid) return <InvalidRequest />;
    const requestHeaders = await headers();
    const principal = await getPrincipal(auth, requestHeaders);
    if (!principal) redirect(`/sign-in?${oauthQuery}`);
    // A grant is for a membership, so someone in no organization here joins one first, then connects again.
    const organizations = await organizationsOf(db, principal.id);
    if (!organizations.length) redirect('/join');
    const clientId = query.get('client_id');
    if (!clientId) return <InvalidRequest />;
    // Fetch public metadata only after signature and session validation; never serialize a client secret.
    const client = await auth.api
      .getOAuthClientPublic({ headers: requestHeaders, query: { client_id: clientId } })
      .catch(error => {
        if (error instanceof APIError && error.status === 'NOT_FOUND') return null;
        throw error;
      });
    if (!client) return <InvalidRequest />;
    // A Connect app's grant is for its own organization, which /connect switched to: named, and not switchable here.
    const connect = query.get('scope')?.split(' ').includes(CONNECT_SCOPE) ? await connectApp(db, clientId) : null;
    if (
      connect &&
      !organizations.find(organization => organization.current && organization.id === connect.organizationId)
    )
      return <InvalidRequest />;
    const scopes: OAuthScopeMetadataMap = connect
      ? {
          ...scopeMetadata,
          [CONNECT_SCOPE]: {
            label: `Link your account in ${connect.organization}`,
            description: `${client.client_name ?? 'The app'} learns which member of ${connect.organization} you are. ${connect.organization}'s API keys can use the sites you sync to it.`,
          },
        }
      : scopeMetadata;
    const approvalHost = hostOf(query.get('redirect_uri'));
    const loopback = !!approvalHost && LOOPBACK.has(approvalHost.replace(/:\d+$/, ''));
    return (
      <main id="main" className={page}>
        <OAuthConsent
          key={oauthQuery}
          oauthQuery={oauthQuery}
          client={{
            name: client.client_name ?? 'An agent',
            logo: client.logo_uri,
            policy: client.policy_uri,
            terms: client.tos_uri,
          }}
          user={{ name: principal.name, email: principal.email }}
          scopeMetadata={scopes}
          loopback={loopback}
          clientHost={hostOf(clientId) ?? clientId}
          organizations={connect ? [] : organizations.map(({ id, name, current }) => ({ id, name, current }))}
        />
      </main>
    );
  };
