import type { OAuthScopeMetadataMap } from '@better-auth-ui/core/plugins/oauth-provider';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { OAuthConsent } from '../components/oauth-consent';
import { apiGet, type ConsentRequest, type Me, type PageApi } from '../lib/page-api';

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
export const consentPage = (api: PageApi) =>
  async function Consent({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
    const params = await searchParams;
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params))
      for (const entry of Array.isArray(value) ? value : value ? [value] : []) query.append(key, entry);
    const oauthQuery = query.toString();
    const signed = await apiGet<{ clientId: string }>(api, `/oauth/request?${oauthQuery}`);
    if (!signed.ok) return <InvalidRequest />;
    const me = await apiGet<Me>(api, '/me');
    if (!me.ok) redirect(`/sign-in?${oauthQuery}`);
    // A grant is for a membership, so someone in no organization here joins one first, then connects again.
    const { user, organization: current, organizations } = me.data;
    if (!current) redirect('/join');
    // The client's public metadata, and a Connect app's organization, which /connect switched to: named, and not
    // switchable here.
    const request = await apiGet<ConsentRequest>(api, `/oauth/consent?${oauthQuery}`);
    if (!request.ok) return <InvalidRequest />;
    const { client, connect } = request.data;
    const clientId = signed.data.clientId;
    const scopes: OAuthScopeMetadataMap = connect
      ? {
          ...scopeMetadata,
          [connect.scope]: {
            label: `Link your account in ${connect.organization}`,
            description: `${client.name ?? 'The app'} learns which member of ${connect.organization} you are. ${connect.organization}'s API keys can use the sites you sync to it.`,
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
            name: client.name ?? 'An agent',
            logo: client.logo ?? undefined,
            policy: client.policy ?? undefined,
            terms: client.terms ?? undefined,
          }}
          user={{ name: user.name, email: user.email }}
          scopeMetadata={scopes}
          loopback={loopback}
          clientHost={hostOf(clientId) ?? clientId}
          organizations={connect ? [] : organizations.map(({ id, name }) => ({ id, name, current: id === current.id }))}
        />
      </main>
    );
  };
