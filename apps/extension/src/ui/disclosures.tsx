import { serverOrigin } from '../server';
import { Button } from './components/button';

// What connected agents get, in both disclosures.
const agentsUse = (what: string) => `Agents you connect can then use ${what} as you.`;

export function SitesDisclosure() {
  return (
    <aside className="grid gap-2 rounded-lg bg-card p-4 text-[13px] leading-relaxed text-soft">
      <strong className="font-medium text-foreground">Sites you add · encrypted sync</strong>
      <p>
        The extension reads cookies, including signed-in sessions, only from sites you add and allow in your browser. It
        uploads them encrypted when you add a site, within seconds of signing in to or out of one, when the browser
        starts, and every minute, to the Clutchbox account you connect, in a tab where you sign in if needed.{' '}
        {agentsUse('those sites')} Sign-in in your agents' browsers is not guaranteed for every site.
      </p>
      <a
        className="text-foreground underline underline-offset-2"
        href={`${serverOrigin}/privacy`}
        target="_blank"
        rel="noreferrer"
      >
        Privacy policy
      </a>
    </aside>
  );
}

export function AllSitesDisclosure({ disabled, onAgree }: { disabled: boolean; onAgree: () => void }) {
  return (
    <aside className="grid justify-items-start gap-2 rounded-lg bg-card p-4 text-[13px] leading-relaxed text-soft">
      <strong className="font-medium text-foreground">All-sites access</strong>
      <p>
        Allowing all sites lets the extension read cookies from every HTTP and HTTPS site in this browser profile,
        including email and banking, except domains you exclude. {agentsUse('all of them')}
      </p>
      <Button disabled={disabled} onClick={onAgree}>
        Agree and allow all sites
      </Button>
    </aside>
  );
}
