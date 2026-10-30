import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AcceptInvitation, JoinPage } from '../components/join';
import { apiGet, type Me, type PageApi } from '../lib/page-api';

export const metadata: Metadata = { title: 'Join · Clutchbox', robots: { index: false } };
const page = 'mx-auto flex w-full max-w-xl justify-center px-5 py-12 sm:px-8';

// /join: where the app sends a person signed in but in no organization here, and the switcher one who can join
// another.
export const joinPage = (api: PageApi) =>
  async function Join() {
    const me = await apiGet<Me>(api, '/me');
    if (!me.ok) redirect('/sign-in');
    return (
      <main id="main" className={page}>
        <JoinPage email={me.data.user.email} member={!!me.data.organization} />
      </main>
    );
  };

// /join/<invitation>: an invitation, for the address it names. Signing in first comes back here.
export const invitationPage = (api: PageApi) =>
  async function Invitation({ params }: { params: Promise<{ invitation: string }> }) {
    const { invitation: id } = await params;
    const me = await apiGet<Me>(api, '/me');
    if (!me.ok) redirect(`/sign-in?${new URLSearchParams({ next: `/join/${id}` })}`);
    return (
      <main id="main" className={page}>
        <AcceptInvitation id={id} email={me.data.user.email} />
      </main>
    );
  };
