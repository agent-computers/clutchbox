import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { databaseSchema } from '@clutchbox/server/database-schema';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from 'vitest';
import { ClutchboxError, createClient } from '../../sdk/src/index';
import { createAuth } from '../../server/src/auth';
import type { ServerConfig } from '../../server/src/config';
import type { Database } from '../../server/src/database';
import { fakeComputerProvider } from '../../server/src/fake-computer-provider';
import { noMetering } from '../../server/src/hooks';
import { membership } from '../../server/src/member-fixtures';
import type { Role } from '../../server/src/members';
import { createOrganization } from '../../server/src/organizations';
import * as schema from '../../server/src/schema';
import { cdpHandler } from './cdp';
import { createApi } from './index';
import { nodeServer } from './node-upgrade';

// The developer REST API and the CDP proxy on the web app's Node server, in process against PGlite and real Better
// Auth, for tests that call them the way developers do: through the SDK, over real HTTP and WebSockets. A fake provider
// stands in for E2B. Call useDeveloperApi() at a test file's top level: it migrates one PGlite template for the file
// and gives each test a clone, with two organizations, Acme and Other.
export function useDeveloperApi() {
  let template: PGlite;
  let pg: PGlite;
  let db: Database;
  let auth: ReturnType<typeof createAuth>;
  let fake: ReturnType<typeof fakeComputerProvider>;
  let server: Server;
  let origin: string;
  let config: ServerConfig;
  let acme: string;
  let other: string;

  // The API's origin as developers' clients reach it (config.ts, apiOrigin): another name for this server, so the CDP
  // URLs the sessions hand out are shown to come from it rather than from the web app's origin.
  const apiOrigin = () => origin.replace('127.0.0.1', 'localhost');
  // A Node request as a fetch Request, body included.
  const toRequest = async (request: IncomingMessage) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers))
      if (typeof value === 'string') headers.set(name, value);
    const hasBody = !['GET', 'HEAD'].includes(request.method ?? 'GET');
    const chunks: Buffer[] = [];
    if (hasBody) for await (const chunk of request) chunks.push(chunk as Buffer);
    return new Request(`${origin}${request.url}`, {
      method: request.method ?? 'GET',
      headers,
      ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
    });
  };
  beforeAll(async () => {
    template = new PGlite();
    await migrate(drizzle(template, { schema: databaseSchema }), {
      migrationsFolder: fileURLToPath(new URL('../../server/migrations', import.meta.url)),
    });
    // The framework's request listener, as Next.js runs the routes: the CDP proxy on its own route, the API's, and
    // Better Auth's.
    const listener = async (request: IncomingMessage, response: ServerResponse) => {
      const url = request.url ?? '/';
      const fetched = await toRequest(request);
      const answer = url.startsWith('/api/v1/cdp')
        ? await cdpHandler({ db, computers: fake.provider })(fetched)
        : url.startsWith('/api/auth')
          ? await auth.handler(fetched)
          : await createApi({ db, auth, origin, apiOrigin: apiOrigin(), computers: fake.provider }).fetch(fetched);
      response.writeHead(answer.status, Object.fromEntries(answer.headers));
      response.end(Buffer.from(await answer.arrayBuffer()));
    };
    server = nodeServer(listener);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    config = {
      APP_ENV: 'test',
      DATABASE_URL: 'postgresql://localhost/synthetic',
      BETTER_AUTH_URL: origin,
      BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
      GOOGLE_CLIENT_ID: 'synthetic.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'synthetic-only',
    };
  });
  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    await template.close();
  });
  beforeEach(async () => {
    pg = (await template.clone()) as PGlite;
    db = drizzle(pg, { schema: databaseSchema }) as unknown as Database;
    await db.insert(schema.installation).values({ dataClass: 'nonproduction' });
    auth = createAuth(db, config);
    await auth.$context;
    fake = fakeComputerProvider();
    vi.stubEnv('CAPTURE_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
    for (const id of ['founder', 'stranger'])
      await db.insert(schema.user).values({ id, name: id, email: `${id}@acme.test`, emailVerified: true });
    acme = (await db.transaction(tx =>
      createOrganization(tx, { name: 'Acme', owner: { id: 'founder', name: 'founder', email: 'founder@acme.test' } }),
    ))!;
    other = (await db.transaction(tx =>
      createOrganization(tx, {
        name: 'Other',
        owner: { id: 'stranger', name: 'stranger', email: 'stranger@acme.test' },
      }),
    ))!;
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await pg.close();
  });

  // A signed-in person with a role in an organization.
  const person = async (id: string, role: Role, organizationId = acme) => {
    await db
      .insert(schema.user)
      .values({ id, name: `Fixture ${id}`, email: `${id}@acme.test`, emailVerified: true })
      .onConflictDoNothing();
    const member = await membership(db, id, organizationId);
    await db.update(schema.memberships).set({ role }).where(eq(schema.memberships.id, member.membershipId));
    const token = randomBytes(32).toString('base64url');
    await db
      .insert(schema.session)
      .values({ id: randomUUID(), userId: id, token, expiresAt: new Date(Date.now() + 3600_000) });
    const signature = createHmac('sha256', config.BETTER_AUTH_SECRET).update(token).digest('base64');
    const name = (await auth.$context).authCookies.sessionToken.name;
    const cookie = `${name}=${encodeURIComponent(`${token}.${signature}`)}`;
    const publicId = (
      await db
        .select({ publicId: schema.memberships.publicId })
        .from(schema.memberships)
        .where(eq(schema.memberships.id, member.membershipId))
    )[0]!.publicId;
    return { cookie, member, publicId };
  };
  // A key for the organization, made by an owner or admin on the Developers page; with every scope, as new keys are, or
  // with captures alone, as keys made before the computers scope are.
  const newKey = async (cookie: string, { capturesOnly = false, organizationId = acme } = {}) => {
    const response = await auth.handler(
      new Request(`${origin}/api/auth/api-key/create`, {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ingest', organizationId }),
      }),
    );
    expect(response.status).toBe(200);
    const { id, key } = await response.json();
    if (capturesOnly)
      await db
        .update(schema.apikey)
        .set({ permissions: JSON.stringify({ captures: ['read'] }) })
        .where(eq(schema.apikey.id, id));
    return { id: id as string, secret: key as string, client: createClient({ server: origin, apiKey: key }) };
  };
  return {
    get db() {
      return db;
    },
    get auth() {
      return auth;
    },
    get fake() {
      return fake;
    },
    get origin() {
      return origin;
    },
    get acme() {
      return acme;
    },
    get other() {
      return other;
    },
    person,
    newKey,
    // A computer session an admin's key opened for a member of Acme.
    async opened() {
      const admin = await person('admin', 'admin');
      const worker = await person('worker', 'member');
      const key = await newKey(admin.cookie);
      return { key, worker, session: await key.client.computers.open({ member: worker.publicId }) };
    },
    // A refusal's status and code, from the SDK.
    refusal: (promise: Promise<unknown>) =>
      promise.then(
        () => null,
        error => (error instanceof ClutchboxError ? [error.status, error.code] : error),
      ),
    rawRequest: (secret: string, method: string, route: string, body?: unknown) =>
      fetch(`${origin}/api/v1${route}`, {
        method,
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      }),
    forkRow: async (computerId: string) =>
      (await db.select().from(schema.computers).where(eq(schema.computers.publicId, computerId)))[0]!,
    computers: () => ({ provider: fake.provider, metering: noMetering }),
  };
}
