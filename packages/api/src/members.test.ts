import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { databaseSchema } from '@agent-computers/server/database-schema';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuth } from '../../server/src/auth';
import { connectBrowser } from '../../server/src/browser-fixtures';
import { ensureExtensionClient } from '../../server/src/browsers';
import { bundle, cookie } from '../../server/src/capture-fixtures';
import { saveCapture } from '../../server/src/captures';
import { openComputerSession } from '../../server/src/computers';
import type { ServerConfig } from '../../server/src/config';
import type { Database } from '../../server/src/database';
import { fakeComputerProvider } from '../../server/src/fake-computer-provider';
import { defaultServerHooks, noMetering } from '../../server/src/hooks';
import { membership } from '../../server/src/member-fixtures';
import type { Role } from '../../server/src/members';
import {
  createOrganization,
  currentMember,
  type Member,
  singleOrganization,
  type Tenancy,
} from '../../server/src/organizations';
import * as schema from '../../server/src/schema';
import { createApi } from './index';

// Members and roles over HTTP, through our routes and Better Auth's organization plugin's (/api/auth/organization): who
// may invite, change roles, remove, and set join domains; joining by invitation and by email domain; switching and
// creating organizations; and what removal and leaving delete.
const origin = 'http://localhost:3097';
const extension = `chrome-extension://${'a'.repeat(32)}`;
const config: ServerConfig = {
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost/synthetic',
  BETTER_AUTH_URL: origin,
  BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
  GOOGLE_CLIENT_ID: 'synthetic.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'synthetic-only',
};
let pg: PGlite;
let db: Database;
let auth: ReturnType<typeof createAuth>;
let fake: ReturnType<typeof fakeComputerProvider>;
let organizationId: string;
// A session cookie for an existing person.
async function sessionFor(id: string) {
  const token = randomBytes(32).toString('base64url');
  await db
    .insert(schema.session)
    .values({ id: randomUUID(), userId: id, token, expiresAt: new Date(Date.now() + 3600_000) });
  const signature = createHmac('sha256', config.BETTER_AUTH_SECRET).update(token).digest('base64');
  return `${(await auth.$context).authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${signature}`)}`;
}
// A signed-in person, in no organization unless a test puts them in one.
async function signedIn(id: string, email = `${id}@acme.test`) {
  await db.insert(schema.user).values({ id, name: `Fixture ${id}`, email, emailVerified: true });
  return sessionFor(id);
}
// A signed-in person in the test's organization with a role.
async function inOrganization(id: string, role: Role) {
  const session = await signedIn(id);
  const joined = await membership(db, id, organizationId);
  await db.update(schema.memberships).set({ role }).where(eq(schema.memberships.id, joined.membershipId));
  return { cookie: session, member: joined };
}
// The deployment's tenancy may let people create organizations; by default it doesn't.
let tenancy: Pick<Tenancy, 'canCreate'> = {};
const api = () =>
  createApi({
    db,
    auth,
    origin,
    computers: fake.provider,
    hooks: { ...defaultServerHooks, tenancy },
  });
function request(cookie: string, method: string, path: string, body?: unknown, from = origin) {
  return api().request(`${origin}/api/v1${path}`, {
    method,
    headers: {
      cookie,
      origin: from,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}
// A call to Better Auth's endpoints, as the web app's auth client makes it.
async function authRequest(cookie: string, method: string, path: string, body?: unknown, from = origin) {
  return auth.handler(
    new Request(`${origin}/api/auth${path}`, {
      method,
      headers: {
        cookie,
        origin: from,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
const publicIdOf = async (member: Member) =>
  (
    await db
      .select({ publicId: schema.memberships.publicId })
      .from(schema.memberships)
      .where(eq(schema.memberships.id, member.membershipId))
  )[0]!.publicId;

let template: PGlite;
beforeAll(async () => {
  template = new PGlite();
  const templateDb = drizzle(template, { schema: databaseSchema });
  await migrate(templateDb, { migrationsFolder: fileURLToPath(new URL('../../server/migrations', import.meta.url)) });
  await ensureExtensionClient(templateDb as unknown as Database, extension);
});
afterAll(() => template.close());
beforeEach(async () => {
  pg = (await template.clone()) as PGlite;
  db = drizzle(pg, { schema: databaseSchema }) as unknown as Database;
  auth = createAuth(db, config);
  await auth.$context;
  fake = fakeComputerProvider();
  await db
    .insert(schema.user)
    .values({ id: 'founder', name: 'Founder', email: 'founder@acme.test', emailVerified: true });
  organizationId = (await db.transaction(tx =>
    createOrganization(tx, { name: 'Acme', owner: { id: 'founder', name: 'Founder', email: 'founder@acme.test' } }),
  ))!;
  await db.insert(schema.oauthClient).values({ id: 'agent-client', clientId: 'agent-client', redirectUris: [] });
  vi.stubEnv('CAPTURE_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  vi.stubEnv('EXTENSION_ORIGINS', extension);
});
afterEach(async () => {
  tenancy = {};
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await pg.close();
});

describe('members and roles', () => {
  it('require a session, the web origin on changes, and a membership for the organization routes', async () => {
    const outsider = await signedIn('outsider');
    const routes = [
      ['GET', '/organization'],
      ['PUT', '/organization/join-domains', { domains: [] }],
      ['POST', '/organization/leave'],
    ] as const;
    for (const [method, path, body] of routes) {
      expect((await request('', method, path, body)).status, `${method} ${path}`).toBe(401);
      const refused = await request(outsider, method, path, body);
      expect(refused.status, `${method} ${path}`).toBe(403);
      expect(await refused.json()).toEqual({ error: 'not_a_member' });
    }
    const { cookie } = await inOrganization('owner2', 'owner');
    for (const [method, path, body] of [
      ['POST', '/organization/leave', undefined],
      ['POST', '/organizations/join', { organizationId: 'org_x' }],
    ] as const)
      expect((await request(cookie, method, path, body, 'https://evil.test')).status, path).toBe(403);
    // Better Auth's own endpoints check the origin too.
    const invite = { email: 'x@acme.test', role: 'member', organizationId };
    expect((await authRequest(cookie, 'POST', '/organization/invite-member', invite, 'https://evil.test')).status).toBe(
      403,
    );
  });

  it('show every member the organization and its people', async () => {
    await inOrganization('admin', 'admin');
    const plain = await inOrganization('plain', 'member');
    const view = await (await request(plain.cookie, 'GET', '/organization')).json();
    expect(view).toMatchObject({
      organization: { id: organizationId, name: 'Acme', personal: false, joinDomains: [] },
      role: 'member',
    });
    expect(
      view.members.map((row: { email: string; role: string; you: boolean }) => [row.email, row.role, row.you]),
    ).toEqual([
      ['founder@acme.test', 'owner', false],
      ['admin@acme.test', 'admin', false],
      ['plain@acme.test', 'member', true],
    ]);
  });

  it('invite an address with a role no higher than the inviter may grant, for only that address to accept', async () => {
    const admin = await inOrganization('admin', 'admin');
    const plain = await inOrganization('plain', 'member');
    const invite = (cookie: string, email: string, role: string) =>
      authRequest(cookie, 'POST', '/organization/invite-member', { email, role, organizationId });
    expect((await invite(plain.cookie, 'newcomer@elsewhere.test', 'member')).ok).toBe(false);
    expect((await invite(admin.cookie, 'newcomer@elsewhere.test', 'owner')).ok).toBe(false);
    expect((await invite(admin.cookie, 'newcomer@elsewhere.test', 'boss')).ok).toBe(false);
    const created = await invite(admin.cookie, 'Newcomer@Elsewhere.test', 'admin');
    expect(created.status).toBe(200);
    const invitation = await created.json();
    expect(invitation).toMatchObject({
      id: expect.stringMatching(/^inv_/),
      email: 'newcomer@elsewhere.test',
      role: 'admin',
      status: 'pending',
    });
    const listed = await authRequest(
      admin.cookie,
      'GET',
      `/organization/list-invitations?organizationId=${organizationId}`,
    );
    expect(await listed.json()).toEqual([expect.objectContaining({ id: invitation.id, role: 'admin' })]);

    // Someone signed in with another address can't see or accept it.
    const accept = (cookie: string, invitationId: string) =>
      authRequest(cookie, 'POST', '/organization/accept-invitation', { invitationId });
    const stranger = await signedIn('stranger', 'stranger@elsewhere.test');
    expect((await authRequest(stranger, 'GET', `/organization/get-invitation?id=${invitation.id}`)).ok).toBe(false);
    expect((await accept(stranger, invitation.id)).status).toBe(403);
    // The address it names joins with its role, and it is used up.
    const newcomer = await signedIn('newcomer', 'newcomer@elsewhere.test');
    expect((await request(newcomer, 'GET', '/organization')).status).toBe(403);
    const shown = await authRequest(newcomer, 'GET', `/organization/get-invitation?id=${invitation.id}`);
    expect(await shown.json()).toMatchObject({ organizationName: 'Acme', role: 'admin' });
    expect((await accept(newcomer, invitation.id)).status).toBe(200);
    expect(await (await request(newcomer, 'GET', '/organization')).json()).toMatchObject({
      organization: { name: 'Acme' },
      role: 'admin',
    });
    expect((await accept(newcomer, invitation.id)).ok).toBe(false);

    // A cancelled or expired invitation no longer works; only owners and admins cancel.
    const late = await signedIn('late', 'late@elsewhere.test');
    const second = await (await invite(admin.cookie, 'late@elsewhere.test', 'member')).json();
    const cancel = (cookie: string) =>
      authRequest(cookie, 'POST', '/organization/cancel-invitation', { invitationId: second.id });
    expect((await cancel(plain.cookie)).ok).toBe(false);
    expect((await cancel(admin.cookie)).status).toBe(200);
    expect((await accept(late, second.id)).ok).toBe(false);
    const third = await (await invite(admin.cookie, 'late@elsewhere.test', 'member')).json();
    await db.update(schema.organizationInvitations).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await accept(late, third.id)).ok).toBe(false);
    expect((await request(late, 'GET', '/organization')).status).toBe(403);
  });

  it('email the invitation when the server sends email, with the link that accepts it', async () => {
    const sent: { to: string; subject: string; text: string }[] = [];
    auth = createAuth(
      db,
      { ...config, SMTP_URL: 'smtp://smtp.example.test', SMTP_FROM: 'team@example.test' },
      { sendEmail: async email => void sent.push(email) },
    );
    const admin = await inOrganization('admin', 'admin');
    const created = await authRequest(admin.cookie, 'POST', '/organization/invite-member', {
      email: 'newcomer@elsewhere.test',
      role: 'member',
      organizationId,
    });
    const { id } = await created.json();
    expect(sent).toEqual([
      {
        to: 'newcomer@elsewhere.test',
        subject: 'Join Acme on Clutchbox',
        text: expect.stringContaining(`${origin}/join/${id}`),
      },
    ]);
  });

  it('let people at an allowed email domain join, and refuse domains anyone can get an address at', async () => {
    const admin = await inOrganization('admin', 'admin');
    const plain = await inOrganization('plain', 'member');
    const put = (cookie: string, domains: unknown) => request(cookie, 'PUT', '/organization/join-domains', { domains });
    expect((await put(plain.cookie, ['acme.test'])).status).toBe(403);
    for (const domains of [['not a domain'], ['acme'], Array.from({ length: 11 }, (_, i) => `d${i}.test`)])
      expect((await put(admin.cookie, domains)).status, JSON.stringify(domains)).toBe(400);
    expect(await (await put(admin.cookie, ['Gmail.com'])).json()).toEqual({ error: 'public_email_domain' });
    expect(await (await put(admin.cookie, [' @ACME.test', 'acme.test', 'acme.example'])).json()).toEqual({
      joinDomains: ['acme.test', 'acme.example'],
    });

    const colleague = await signedIn('colleague', 'colleague@acme.example');
    const stranger = await signedIn('stranger', 'stranger@other.test');
    const [acme] = (await (await request(colleague, 'GET', '/organizations/joinable')).json()).organizations;
    expect(acme).toEqual({ id: expect.stringMatching(/^org_/), name: 'Acme' });
    expect((await (await request(stranger, 'GET', '/organizations/joinable')).json()).organizations).toEqual([]);
    expect((await request(stranger, 'POST', '/organizations/join', { organizationId: acme.id })).status).toBe(404);
    expect((await request(colleague, 'POST', '/organizations/join', { organizationId: 'nope' })).status).toBe(400);
    const joined = await request(colleague, 'POST', '/organizations/join', { organizationId: acme.id });
    expect(await joined.json()).toMatchObject({ joined: true, organization: { id: acme.id } });
    expect((await (await request(colleague, 'GET', '/organization')).json()).role).toBe('member');
    expect((await (await request(colleague, 'GET', '/organizations/joinable')).json()).organizations).toEqual([]);
    expect((await request(colleague, 'POST', '/organizations/join', { organizationId: acme.id })).status).toBe(409);
  });

  it('let owners set any role and admins only admin and member, keeping an owner', async () => {
    const founder = { cookie: await sessionFor('founder'), member: (await currentMember(db, 'founder'))! };
    const admin = await inOrganization('admin', 'admin');
    const plain = await inOrganization('plain', 'member');
    const update = (cookie: string, target: Member, role: unknown) =>
      publicIdOf(target).then(memberId =>
        authRequest(cookie, 'POST', '/organization/update-member-role', { memberId, role, organizationId }),
      );
    const roleOf = async (member: Member) =>
      (
        await db
          .select({ role: schema.memberships.role })
          .from(schema.memberships)
          .where(eq(schema.memberships.id, member.membershipId))
      )[0]?.role;
    expect((await update(plain.cookie, admin.member, 'member')).ok).toBe(false);
    expect((await update(admin.cookie, plain.member, 'owner')).ok).toBe(false);
    expect((await update(admin.cookie, founder.member, 'member')).ok).toBe(false);
    expect((await update(admin.cookie, plain.member, 'boss')).ok).toBe(false);
    expect(await roleOf(plain.member)).toBe('member');
    expect((await update(admin.cookie, plain.member, 'admin')).status).toBe(200);
    expect(await roleOf(plain.member)).toBe('admin');
    // The last owner stays one until another is made.
    expect((await update(founder.cookie, founder.member, 'admin')).ok).toBe(false);
    expect((await update(founder.cookie, admin.member, 'owner')).status).toBe(200);
    expect((await update(founder.cookie, founder.member, 'member')).status).toBe(200);
    expect(await roleOf(founder.member)).toBe('member');
    // Another organization's member is out of reach.
    await db.insert(schema.user).values({ id: 'other', name: 'Other', email: 'other@b.test', emailVerified: true });
    const elsewhere = await db.transaction(tx =>
      createOrganization(tx, { name: 'B', owner: { id: 'other', name: 'Other', email: 'other@b.test' } }),
    );
    const otherMember = await membership(db, 'other', elsewhere!);
    expect((await update(admin.cookie, otherMember, 'member')).ok).toBe(false);
  });

  it("remove a member, deleting what they had there and ending their browsers' and agents' access", async () => {
    const admin = await inOrganization('admin', 'admin');
    const leaver = await inOrganization('leaver', 'member');
    // The same person in another organization keeps everything there.
    await db.insert(schema.user).values({ id: 'other', name: 'Other', email: 'other@b.test', emailVerified: true });
    const elsewhere = await membership(
      db,
      'leaver',
      (await db.transaction(tx =>
        createOrganization(tx, { name: 'B', owner: { id: 'other', name: 'Other', email: 'other@b.test' } }),
      ))!,
    );
    const browserTokens = await connectBrowser(auth, leaver.cookie, { extensionOrigin: extension });
    for (const member of [leaver.member, elsewhere]) {
      await saveCapture(db, member, bundle([cookie()]));
      const opened = await openComputerSession(
        db,
        { provider: fake.provider, metering: noMetering },
        { ...member, clientId: 'agent-client' },
      );
      if ('error' in opened) throw new Error(opened.error);
      await opened.done();
      await db.insert(schema.oauthConsent).values({
        id: randomUUID(),
        clientId: 'agent-client',
        userId: 'leaver',
        referenceId: await publicIdOf(member),
        scopes: ['mcp:tools'],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    const asBrowser = () =>
      api().request(`${origin}/api/v1/me`, {
        headers: { authorization: `Bearer ${browserTokens.access_token}`, origin: extension },
      });
    expect((await asBrowser()).status).toBe(200);

    const id = await publicIdOf(leaver.member);
    expect(
      (await request(leaver.cookie, 'DELETE', `/organization/members/${await publicIdOf(admin.member)}`)).status,
    ).toBe(403);
    expect(
      (await request(admin.cookie, 'DELETE', `/organization/members/${await publicIdOf(admin.member)}`)).status,
    ).toBe(403);
    expect((await request(admin.cookie, 'DELETE', `/organization/members/${id}`)).status).toBe(200);
    expect((await request(admin.cookie, 'DELETE', `/organization/members/${id}`)).status).toBe(404);

    expect(fake.calls.kill).toBe(1);
    expect((await asBrowser()).status).toBe(401);
    const owners = (rows: { membershipId: number }[]) => rows.map(row => row.membershipId);
    expect(owners(await db.select({ membershipId: schema.captures.membershipId }).from(schema.captures))).toEqual([
      elsewhere.membershipId,
    ]);
    expect(owners(await db.select({ membershipId: schema.computers.membershipId }).from(schema.computers))).toEqual([
      elsewhere.membershipId,
    ]);
    expect((await db.select({ referenceId: schema.oauthConsent.referenceId }).from(schema.oauthConsent)).length).toBe(
      1,
    );
    expect(await currentMember(db, 'leaver')).toEqual(elsewhere);
  });

  it('let anyone leave except the last owner', async () => {
    const plain = await inOrganization('plain', 'member');
    const owner = await inOrganization('owner2', 'owner');
    expect(await (await request(plain.cookie, 'POST', '/organization/leave')).json()).toEqual({ left: true });
    expect((await request(plain.cookie, 'GET', '/organization')).status).toBe(403);
    expect((await request(owner.cookie, 'POST', '/organization/leave')).status).toBe(200);
    // The founder is now the last owner.
    const founder = (await currentMember(db, 'founder'))!;
    await db.update(schema.memberships).set({ role: 'member' }).where(eq(schema.memberships.id, founder.membershipId));
    const solo = await inOrganization('solo', 'owner');
    expect(await (await request(solo.cookie, 'POST', '/organization/leave')).json()).toEqual({ error: 'last_owner' });
  });

  it("keep Better Auth's leave, remove, and delete off, which would skip the cleanup ours do", async () => {
    const admin = await inOrganization('admin', 'admin');
    const plain = await inOrganization('plain', 'member');
    expect((await authRequest(plain.cookie, 'POST', '/organization/leave', { organizationId })).status).toBe(404);
    const memberIdOrEmail = await publicIdOf(plain.member);
    const removed = await authRequest(admin.cookie, 'POST', '/organization/remove-member', {
      memberIdOrEmail,
      organizationId,
    });
    expect(removed.status).toBe(404);
    const founder = await sessionFor('founder');
    expect((await authRequest(founder, 'POST', '/organization/delete', { organizationId })).ok).toBe(false);
    expect(await currentMember(db, 'plain')).toEqual(plain.member);
  });
});

describe('switching and creating organizations', () => {
  it('list your organizations, switch only to your own, and act in the one switched to', async () => {
    const { cookie } = await inOrganization('person', 'member');
    expect((await request('', 'GET', '/organizations')).status).toBe(401);
    await db.insert(schema.user).values({ id: 'other', name: 'Other', email: 'other@b.test', emailVerified: true });
    const theirs = (await db.transaction(tx =>
      createOrganization(tx, { name: 'Theirs', owner: { id: 'other', name: 'Other', email: 'other@b.test' } }),
    ))!;
    const own = (await db.transaction(tx =>
      createOrganization(tx, { name: 'Own', owner: { id: 'person', name: 'P', email: 'person@acme.test' } }),
    ))!;
    const listed = await (await request(cookie, 'GET', '/organizations')).json();
    expect(listed).toEqual({
      organizations: [
        expect.objectContaining({ id: organizationId, name: 'Acme', role: 'member', personal: false, current: true }),
        expect.objectContaining({ id: own, name: 'Own', role: 'owner', personal: false, current: false }),
      ],
      canCreate: false,
    });
    const setActive = (body: unknown, from = origin) =>
      authRequest(cookie, 'POST', '/organization/set-active', body, from);
    expect((await setActive({ organizationId: own }, 'https://evil.test')).status).toBe(403);
    expect((await setActive({ organizationId: theirs })).ok).toBe(false);
    expect((await request(cookie, 'GET', '/organization')).status).toBe(200);
    expect((await (await request(cookie, 'GET', '/organization')).json()).organization.name).toBe('Acme');
    expect((await setActive({ organizationId: own })).status).toBe(200);
    expect(await (await request(cookie, 'GET', '/organization')).json()).toMatchObject({
      organization: { name: 'Own' },
      role: 'owner',
    });
    // Agents and the extension act there too, and a new session starts there.
    expect((await currentMember(db, 'person'))?.organizationId).toBe(own);
    const later = await (await auth.$context).internalAdapter.createSession('person');
    expect((later as typeof later & { activeOrganizationId: string | null }).activeOrganizationId).toBe(own);
  });

  it('create one only where the tenancy offers it, and act in it', async () => {
    const { cookie } = await inOrganization('person', 'member');
    const create = (body: unknown, from = origin) => authRequest(cookie, 'POST', '/organization/create', body, from);
    expect((await create({ name: 'Team', slug: 'team' })).ok).toBe(false);
    let allowed = true;
    tenancy = { canCreate: async () => allowed };
    auth = createAuth(db, config, { tenancy: { ...singleOrganization, ...tenancy } });
    expect((await (await request(cookie, 'GET', '/organizations')).json()).canCreate).toBe(true);
    expect((await create({ name: 'Team', slug: 'team' }, 'https://evil.test')).status).toBe(403);
    for (const name of ['   ', 'x'.repeat(101)])
      expect((await create({ name, slug: 'team' })).ok, JSON.stringify(name)).toBe(false);
    const created = await create({ name: '  Team  ', slug: 'team' });
    expect(created.status).toBe(200);
    const organization = await created.json();
    expect(organization).toMatchObject({ id: expect.stringMatching(/^org_/), name: 'Team' });
    expect(organization.slug).not.toBe('team');
    expect(await (await request(cookie, 'GET', '/organization')).json()).toMatchObject({
      organization: { id: organization.id, name: 'Team' },
      role: 'owner',
    });
    expect((await currentMember(db, 'person'))?.organizationId).toBe(organization.id);
    allowed = false;
    expect((await create({ name: 'More', slug: 'more' })).ok).toBe(false);
  });

  it('act in an organization once you join it', async () => {
    const admin = await inOrganization('admin', 'admin');
    const invitation = await (
      await authRequest(admin.cookie, 'POST', '/organization/invite-member', {
        email: 'other@b.test',
        role: 'member',
        organizationId,
      })
    ).json();
    await db.insert(schema.user).values({ id: 'other', name: 'Other', email: 'other@b.test', emailVerified: true });
    await db.transaction(tx =>
      createOrganization(tx, { name: 'Theirs', owner: { id: 'other', name: 'Other', email: 'other@b.test' } }),
    );
    const other = await sessionFor('other');
    expect((await (await request(other, 'GET', '/organization')).json()).organization.name).toBe('Theirs');
    await authRequest(other, 'POST', '/organization/accept-invitation', { invitationId: invitation.id });
    expect((await (await request(other, 'GET', '/organization')).json()).organization.name).toBe('Acme');
  });
});
