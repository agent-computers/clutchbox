'use client';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from '@clutchbox/ui/components/sidebar';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ArrowUpRight,
  Bot,
  Circle,
  CircleCheck,
  Code,
  LayoutDashboard,
  Monitor,
  RefreshCw,
  Settings,
  TriangleAlert,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, type MouseEvent, type ReactNode, type RefObject, useContext, useEffect, useRef } from 'react';
import { shellIcons, useShell } from '../deployment';
import {
  api,
  browsersQuery,
  computerQuery,
  grantsQuery,
  organizationsQuery,
  type SetupView,
  setupQuery,
  syncQuery,
} from '../lib/api';
import { computerStatus } from '../lib/computer';
import { UserButton } from './auth/user-button';
import { OrganizationSwitcher } from './organization-switcher';
import { StarLink } from './star-link';

export type AppUser = { id: string; name: string; email: string; image?: string | null };
const UserContext = createContext<AppUser | null>(null);
// The signed-in user, from the app layout.
export const useAppUser = () => useContext(UserContext) as AppUser;

// A page that must confirm before the user leaves it (live view in control) registers a guard. Given how to leave, the
// guard returns true when it takes over: it leaves later, or not at all.
type LeaveGuard = (leave: () => void) => boolean;
const GuardContext = createContext<RefObject<LeaveGuard | null> | null>(null);
export function useLeaveGuard(guard: LeaveGuard | null) {
  const ref = useContext(GuardContext);
  useEffect(() => {
    if (!ref) return;
    ref.current = guard;
    return () => {
      if (ref.current === guard) ref.current = null;
    };
  }, [ref, guard]);
}

type Step = keyof SetupView['items'];
const pages: { href: string; label: string; icon: typeof Bot; step?: Step }[] = [
  { href: '/app', label: 'Overview', icon: LayoutDashboard },
  { href: '/app/sync', label: 'Browser sync', icon: RefreshCw, step: 'browserSync' },
  { href: '/app/agents', label: 'Agents', icon: Bot, step: 'agents' },
  { href: '/app/computer', label: 'Computer', icon: Monitor, step: 'computer' },
];
// Developers is for owners and admins, who are the only ones who can use it.
const lowerPages = [
  { href: '/app/organization', label: 'Organization', icon: Users },
  { href: '/app/developers', label: 'Developers', icon: Code, managers: true },
  { href: '/app/settings', label: 'Settings', icon: Settings },
];

const POLL_MS = 5000;

// The signed-in app: a sidebar of pages, and the queries they share. Until the
// user is set up, the sidebar marks each setup step done or to do, and the setup queries poll so the marks tick live
// while the user works in the extension or an agent; after, it shows the computer's status.
export function AppShell({ user, children }: { user: AppUser; children: ReactNode }) {
  const router = useRouter();
  const setup = useQuery({ ...setupQuery, refetchInterval: query => (query.state.data?.setUpAt ? false : POLL_MS) });
  const setUp = !!setup.data?.setUpAt;
  useQuery({ ...computerQuery, refetchInterval: POLL_MS });
  useQuery({ ...browsersQuery, refetchInterval: POLL_MS });
  useQuery({ ...grantsQuery, refetchInterval: setUp ? false : POLL_MS });
  // The computer follows this browser's time zone from its next open; the server stores it only when it changed.
  const { mutate: reportTimeZone } = useMutation({
    mutationFn: (timeZone: string) => api('/time-zone', 'PUT', { timeZone }),
  });
  useEffect(() => reportTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone), [reportTimeZone]);
  const guard = useRef<LeaveGuard | null>(null);
  const home = useShell().homeHref ?? '/app';
  return (
    <UserContext value={user}>
      <GuardContext value={guard}>
        <SidebarProvider>
          <AppSidebar user={user} setup={setup.data} guard={guard} />
          <SidebarInset id="main">
            <header className="flex items-center gap-2 border-b px-3 py-2 md:hidden">
              <SidebarTrigger className="size-11" aria-label="Open the menu" />
              <Link
                href={home}
                onClick={event => {
                  if (guard.current?.(() => router.push(home))) event.preventDefault();
                }}
                className="font-serif text-lg font-medium italic"
                aria-label="Clutchbox home page"
              >
                clutchbox
              </Link>
            </header>
            {children}
          </SidebarInset>
        </SidebarProvider>
      </GuardContext>
    </UserContext>
  );
}

function AppSidebar({
  user,
  setup,
  guard,
}: {
  user: AppUser;
  setup: SetupView | undefined;
  guard: RefObject<LeaveGuard | null>;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { setOpenMobile } = useSidebar();
  const shell = useShell();
  const home = shell.homeHref ?? '/app';
  const footerLinks = shell.footerLinks ?? [];
  const external = footerLinks.filter(link => link.external);
  const internal = footerLinks.filter(link => !link.external);
  const { data: computer } = useQuery(computerQuery);
  const { data: sync } = useQuery(syncQuery);
  const syncStopped = !!sync && (sync.disconnected || !!sync.settings?.paused);
  const role = useQuery(organizationsQuery).data?.organizations.find(organization => organization.current)?.role;
  const manager = role === 'owner' || role === 'admin';
  const status = computer && computerStatus(computer);
  // Every in-app link goes through the leave guard; the menu closes on mobile either way.
  const follow = (href: string) => (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    setOpenMobile(false);
    if (href !== pathname && guard.current?.(() => router.push(href))) event.preventDefault();
  };
  const go = (href: string) => {
    setOpenMobile(false);
    if (!guard.current?.(() => router.push(href))) router.push(href);
  };
  const item = ({ href, label, icon: Icon }: { href: string; label: string; icon: typeof Bot }, badge?: ReactNode) => (
    <SidebarMenuItem key={href}>
      <SidebarMenuButton
        className="h-11 data-active:[&>svg]:text-brand"
        isActive={pathname === href}
        render={<Link href={href} onClick={follow(href)} aria-current={pathname === href ? 'page' : undefined} />}
      >
        <Icon aria-hidden />
        <span>{label}</span>
      </SidebarMenuButton>
      {badge && <SidebarMenuBadge className="top-1/2! -translate-y-1/2">{badge}</SidebarMenuBadge>}
    </SidebarMenuItem>
  );
  const marker = (step: Step | undefined, href: string) => {
    if (href === '/app/sync' && syncStopped)
      return <TriangleAlert aria-label={sync?.disconnected ? 'Off' : 'Paused'} className="size-4 text-destructive" />;
    if (setup && !setup.setUpAt && step)
      return setup.items[step] ? (
        <CircleCheck aria-label="Done" className="size-4 text-foreground" />
      ) : (
        <Circle aria-label="To do" className="size-4 text-muted-foreground" />
      );
    if (href === '/app/computer' && status)
      return (
        <span className="flex items-center gap-1.5 font-normal text-muted-foreground">
          <span aria-hidden className={`size-1.5 rounded-full ${status.dot}`} />
          {status.short}
        </span>
      );
  };
  return (
    <Sidebar>
      <SidebarHeader className="gap-4 px-4 pt-6 pb-4">
        <div className="flex items-center justify-between gap-2">
          <Link
            href={home}
            onClick={follow(home)}
            className="font-serif text-lg font-medium italic"
            aria-label="Clutchbox home page"
          >
            clutchbox
          </Link>
          {shell.githubRepo && <StarLink repo={shell.githubRepo} className="-mr-2" />}
        </div>
        <OrganizationSwitcher onCreated={() => go('/app/organization')} onJoin={() => go('/join')} />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>{pages.map(page => item(page, marker(page.step, page.href)))}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup className="mt-auto">
          <SidebarGroupContent>
            <SidebarMenu>
              {shell.morePages?.map(({ icon, badge, ...page }) =>
                item(
                  { ...page, icon: shellIcons[icon] },
                  badge && <span className="rounded-full px-1.5 text-xs font-normal ring-1 ring-border">{badge}</span>,
                ),
              )}
              {lowerPages.filter(page => !page.managers || manager).map(page => item(page))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="gap-3 border-t p-3">
        <UserButton user={user} />
        {footerLinks.length > 0 && (
          <div className="grid justify-items-start gap-1 px-1 text-xs text-muted-foreground">
            {external.map(({ href, label }) => (
              <Link
                key={href}
                className="inline-flex items-center gap-0.5 hover:text-foreground"
                href={href}
                onClick={follow(href)}
              >
                {label}
                <ArrowUpRight aria-hidden className="size-3" />
              </Link>
            ))}
            {internal.length > 0 && (
              <p className="flex gap-4">
                {internal.map(({ href, label }) => (
                  <Link key={href} className="hover:text-foreground" href={href} onClick={follow(href)}>
                    {label}
                  </Link>
                ))}
              </p>
            )}
          </div>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}

// A page's heading and column. Wide pages (live view) get more room.
export function AppPage({
  title,
  description,
  wide,
  children,
}: {
  title: string;
  description?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`mx-auto grid w-full gap-6 px-5 pt-10 pb-16 sm:px-8 ${wide ? 'max-w-5xl' : 'max-w-3xl'}`}>
      <header className="grid gap-2">
        <h1 className="font-heading text-4xl leading-[1.05] font-medium tracking-[-0.015em] sm:text-5xl">{title}</h1>
        {description && <p className="max-w-prose text-foreground">{description}</p>}
      </header>
      {children}
    </div>
  );
}
