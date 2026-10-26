import type { Metadata } from 'next';
import localFont from 'next/font/local';
import '@agent-computers/web/styles.css';
import { AuthProvider } from '@agent-computers/web/components/auth-provider';
import { siteOrigin } from '@agent-computers/web/lib/site';
import { deployment } from '@/deployment/ui';

// The type families live in @agent-computers/ui (packages/ui).
const garamond = localFont({
  src: [
    { path: '../../../packages/ui/src/fonts/EBGaramond.woff2', weight: '400 500', style: 'normal' },
    { path: '../../../packages/ui/src/fonts/EBGaramond-Italic.woff2', weight: '400 500', style: 'italic' },
  ],
  variable: '--font-garamond',
  display: 'swap',
});
const plex = localFont({
  src: '../../../packages/ui/src/fonts/IBMPlexSans.woff2',
  weight: '100 700',
  variable: '--font-plex',
  display: 'swap',
});
export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin),
  title: 'Clutchbox',
  description: 'Your agents, already signed in. Clutchbox syncs your browser states to browsers your agents use.',
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${garamond.variable} ${plex.variable}`}>
      <body>
        <a
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-card focus:px-3 focus:py-2"
          href="#main"
        >
          Skip to content
        </a>
        <AuthProvider>{children}</AuthProvider>
        <deployment.Analytics />
      </body>
    </html>
  );
}
