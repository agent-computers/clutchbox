import type { MetadataRoute } from 'next';

// An organization's own app, not a public site: nothing in it is for search engines.
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: '*', disallow: '/' } };
}
