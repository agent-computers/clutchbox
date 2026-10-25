// The public origin is the auth origin, so canonical, sitemap, and share URLs match sign-in's.
export const siteOrigin = process.env.BETTER_AUTH_URL ?? 'http://localhost:3000';
