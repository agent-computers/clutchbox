import { getPrincipal } from '@agent-computers/server/auth';
import { invitationView } from '@agent-computers/server/members';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { AcceptInvitation, JoinPage } from '../components/join';
import type { GetServices } from '../services';

export const metadata: Metadata = { title: 'Join · Clutchbox', robots: { index: false } };
const page = 'mx-auto flex w-full max-w-xl justify-center px-5 py-12 sm:px-8';

// /join: where the app sends a person signed in but in no organization here.
export const joinPage = (getServices: GetServices) =>
  async function Join() {
    const { auth } = await getServices();
    const principal = await getPrincipal(auth, await headers());
    if (!principal) redirect('/sign-in');
    return (
      <main id="main" className={page}>
        <JoinPage email={principal.email} />
      </main>
    );
  };

// /join/<token>: an invitation link. Signing in first comes back here.
export const invitationPage = (getServices: GetServices) =>
  async function Invitation({ params }: { params: Promise<{ token: string }> }) {
    const { token } = await params;
    const { auth, db } = await getServices();
    const principal = await getPrincipal(auth, await headers());
    if (!principal) redirect(`/sign-in?${new URLSearchParams({ next: `/join/${token}` })}`);
    const invitation = await invitationView(db, token);
    return (
      <main id="main" className={page}>
        <AcceptInvitation
          token={token}
          invitation={invitation && { organization: invitation.organization, role: invitation.role }}
        />
      </main>
    );
  };
