// The public origin is the auth origin, so canonical, sitemap, and share URLs match sign-in's.
export const siteOrigin = process.env.BETTER_AUTH_URL ?? 'http://localhost:3000';
// Where agents and developers' clients reach the API, as the server's config reads API_ORIGIN: the MCP URL pages show.
export const apiOrigin = process.env.API_ORIGIN ? new URL(process.env.API_ORIGIN).origin : siteOrigin;
