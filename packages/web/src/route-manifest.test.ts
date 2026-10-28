import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LIVE_VIEW_MAX_DURATION_MS, ROUTE_MAX_DURATION_MS } from '@clutchbox/server/computer-timing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkApp, parseGroups, routeFiles, writeApp } from '../scripts/generate-routes';
import { routeManifest } from './route-manifest';

describe('route manifest', () => {
  it('writes the computer timings into the route files as whole-second literals', () => {
    const files = routeFiles();
    for (const entry of routeManifest)
      if (entry.segment?.maxDuration !== undefined) expect(Number.isInteger(entry.segment.maxDuration)).toBe(true);
    expect(files.get('api/mcp/route.ts')).toContain(`\nexport const maxDuration = ${ROUTE_MAX_DURATION_MS / 1000};\n`);
    expect(files.get('api/v1/[[...route]]/route.ts')).toContain(
      `\nexport const maxDuration = ${ROUTE_MAX_DURATION_MS / 1000};\n`,
    );
    expect(files.get('api/v1/live-view/route.ts')).toContain(
      `\nexport const maxDuration = ${LIVE_VIEW_MAX_DURATION_MS / 1000};\n`,
    );
  });

  it('accepts only route groups for routes it lists', () => {
    expect(parseGroups(['sign-in=(site),consent=(site)'])).toEqual({ 'sign-in': '(site)', consent: '(site)' });
    expect(() => parseGroups(['sign-up=(site)'])).toThrow(/no route/);
    expect(() => parseGroups(['sign-in=site'])).toThrow(/<id>=\(<group>\)/);
  });
});

describe('generate-routes', () => {
  let app: string;
  const groups = { 'sign-in': '(auth)', consent: '(auth)' };
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(app, 'app', path)), { recursive: true });
    writeFileSync(join(app, 'app', path), text);
  };
  beforeEach(() => {
    app = mkdtempSync(join(tmpdir(), 'generate-routes-'));
    put('layout.tsx', 'export default function Root() {}\n');
    put('app/billing/page.tsx', 'export default function Billing() {}\n');
  });
  afterEach(() => rmSync(app, { recursive: true, force: true }));

  it('writes every route into the named groups and leaves hand-written routes on other URLs alone', () => {
    writeApp(app, groups);
    expect(checkApp(app, groups)).toEqual([]);
    expect(readFileSync(join(app, 'app/(auth)/sign-in/page.tsx'), 'utf8')).toContain('signInPage(getServices)');
    expect(writeApp(app, groups)).toEqual([]);
  });

  it('fails on a changed or missing route file, and on a hand-written route that claims a manifest URL', () => {
    writeApp(app, groups);
    put('api/mcp/route.ts', readFileSync(join(app, 'app/api/mcp/route.ts'), 'utf8').replace('120', '60'));
    rmSync(join(app, 'app/app/sync/page.tsx'));
    put('(site)/app/agents/page.tsx', 'export default function Agents() {}\n');
    put('(site)/app/layout.tsx', 'export default function Layout() {}\n');
    expect(checkApp(app, groups)).toEqual([
      'app/app/sync/page.tsx is missing',
      'app/api/mcp/route.ts differs from the manifest',
      'app/(site)/app/agents/page.tsx claims the page or route at /app/agents, which the manifest gives app/app/agents/page.tsx',
      'app/(site)/app/layout.tsx claims the layout at /app, which the manifest gives app/app/layout.tsx',
    ]);
  });

  it('removes a generated route the manifest no longer lists, and only that', () => {
    writeApp(app, groups);
    put('app/old/page.tsx', readFileSync(join(app, 'app/app/agents/page.tsx'), 'utf8'));
    expect(checkApp(app, groups)).toEqual(['app/app/old/page.tsx is generated but no longer in the manifest']);
    expect(writeApp(app, groups)).toEqual(['removed app/app/old/page.tsx']);
    expect(checkApp(app, groups)).toEqual([]);
    expect(readFileSync(join(app, 'app/app/billing/page.tsx'), 'utf8')).toContain('Billing');
  });
});
