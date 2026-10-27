import { getPrincipal } from '@agent-computers/server/auth';
import { currentMember } from '@agent-computers/server/organizations';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { AcceptInvitation, JoinPage } from '../components/join';
import type { GetServices } from '../services';

export const metadata: Metadata = { title: 'Join · Clutchbox', robots: { index: false } };
const page = 'mx-auto flex w-full max-w-xl justify-center px-5 py-12 sm:px-8';

// /join: where the app sends a person signed in but in no organization here, and the switcher one who can join
// another.
export const joinPage = (getServices: GetServices) =>
  async function Join() {
    const { auth, db } = await getServices();
    const principal = await getPrincipal(auth, await headers());
    if (!principal) redirect('/sign-in');
    const member = !!(await currentMember(db, principal.id));
    return (
      <main id="main" className={page}>
        <JoinPage email={principal.email} member={member} />
      </main>
    );
  };

// /join/<invitation>: an invitation, for the address it names. Signing in first comes back here.
export const invitationPage = (getServices: GetServices) =>
  async function Invitation({ params }: { params: Promise<{ invitation: string }> }) {
    const { invitation: id } = await params;
    const { auth } = await getServices();
    const principal = await getPrincipal(auth, await headers());
    if (!principal) redirect(`/sign-in?${new URLSearchParams({ next: `/join/${id}` })}`);
    return (
      <main id="main" className={page}>
        <AcceptInvitation id={id} email={principal.email} />
      </main>
    );
  };
