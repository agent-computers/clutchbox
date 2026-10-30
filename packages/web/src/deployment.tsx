'use client';
import { Code, CreditCard } from 'lucide-react';
import { type ComponentType, createContext, type ReactNode, useContext } from 'react';

// Icons a deployment's extra pages can name. Shell extras cross from the server layout to the client shell, so they
// are plain data: a key into this map, not a component.
export const shellIcons = { code: Code, creditCard: CreditCard };
export type ShellIcon = keyof typeof shellIcons;

// What a deployment adds to the signed-in app's shell. Without any, the app shows only the product's own pages, with no
// landing page or footer links, and offers only the manual build of the extension.
export type ShellExtras = {
  // The deployment's landing page, linked in the sidebar footer.
  landing?: { href: string; label: string };
  // Sidebar pages above Settings, with an optional badge such as "Soon".
  morePages?: { href: string; label: string; icon: ShellIcon; badge?: string }[];
  // Sidebar footer links, on one line.
  footerLinks?: { href: string; label: string }[];
  // Hashes of the old account page that /app moves on to the deployment's own pages, such as '#billing'.
  sectionPages?: Record<string, string>;
  // The extension's store listing. Without it, the app offers only the manual build.
  chromeWebStoreUrl?: string;
  // A GitHub repository as owner/name, such as 'clutchbox-hq/clutchbox'. With it, the sidebar footer links to it.
  githubRepo?: string;
};

// A deployment's web app: its analytics, rendered on every page, and its shell extras.
export type UiDeployment = { Analytics: ComponentType; shell: ShellExtras };

const ShellContext = createContext<ShellExtras>({});
export function ShellProvider({ shell, children }: { shell: ShellExtras; children: ReactNode }) {
  return <ShellContext value={shell}>{children}</ShellContext>;
}
export const useShell = () => useContext(ShellContext);
