import { randomUUID } from 'node:crypto';
import type { Capture, CapturedCookie } from '@agent-computers/capture';

// Synthetic capture builders for tests only; no real browser data.
export const cookie = (overrides: Partial<CapturedCookie> = {}): CapturedCookie => ({
  name: 'sid',
  value: 'local',
  domain: 'example.com',
  hostOnly: true,
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'lax',
  session: false,
  expirationDate: 2_000_000_000,
  storeId: '0',
  ...overrides,
});
export const bundle = (cookies: CapturedCookie[], completedAt = new Date()): Capture => ({
  schemaVersion: 2,
  id: randomUUID(),
  scope: { mode: 'whole-browser', excludedDomains: [] },
  startedAt: new Date(completedAt.getTime() - 1000).toISOString(),
  completedAt: completedAt.toISOString(),
  consistency: 'non-atomic-cookie-read',
  coverage: 'cookies-only',
  storeId: '0',
  cookies,
});
// A capture of added sites only; cookies must belong to `sites`.
export const siteBundle = (cookies: CapturedCookie[], sites: string[], completedAt = new Date()): Capture => ({
  ...bundle(cookies, completedAt),
  scope: { mode: 'sites', sites, excludedDomains: [] },
});
