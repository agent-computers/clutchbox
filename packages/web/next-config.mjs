// The product's base Next.js config, which each app's next.config.ts spreads and extends (its own transpiled packages
// and env). Plain JavaScript, so loading it needs no type stripping.
export const transpilePackages = [
  '@agent-computers/api',
  '@agent-computers/server',
  '@agent-computers/apply',
  '@agent-computers/capture',
  '@agent-computers/computer',
  '@agent-computers/e2b',
  '@agent-computers/ui',
  '@agent-computers/web',
];

/** @type {import('next').NextConfig} */
const config = {
  agentRules: false,
  poweredByHeader: false,
  transpilePackages,
  serverExternalPackages: ['pg'],
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};
export default config;
