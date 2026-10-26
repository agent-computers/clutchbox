import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
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
import { invitationView, type Role } from '../../server/src/members';
import { createOrganization, currentMember, type Member, type Tenancy } from '../../server/src/organizations';
import * as schema from '../../server/src/schema';
import { createApi } from './index';

// Members and roles over HTTP: who may invite, change roles, remove, and set join domains; joining by invitation and
// by email domain; and what removal and leaving delete.
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
let organizationId: number;
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
let tenancy: Pick<Tenancy, 'create'> = {};
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
const publicIdOf = async (member: Member) =>
  (
    await db
      .select({ publicId: schema.memberships.publicId })
      .from(schema.memberships)
      .where(eq(schema.memberships.id, member.membershipId))
  )[0]!.publicId;
const tokenOf = (url: string) => new URL(url).pathname.split('/').pop()!;

let template: PGlite;
beforeAll(async () => {
  template = new PGlite();
  const templateDb = drizzle(template, { schema });
  await migrate(templateDb, { migrationsFolder: fileURLToPath(new URL('../../server/migrations', import.meta.url)) });
  await ensureExtensionClient(templateDb as unknown as Database, extension);
});
afterAll(() => template.close());
beforeEach(async () => {
  pg = (await template.clone()) as PGlite;
  db = drizzle(pg, { schema }) as unknown as Database;
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
      ['GET', '/organization/invitations'],
      ['POST', '/organization/invitations', { role: 'member' }],
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
      ['POST', '/organization/invitations', { role: 'member' }],
      ['POST', '/organization/leave', undefined],
      ['POST', '/invitations/accept', { token: 'x' }],
      ['POST', '/organizations/join', { organizationId: 'org_x' }],
    ] as const)
      expect((await request(cookie, method, path, body, 'https://evil.test')).status, path).toBe(403);
  });

  it('show every member the organization and its people, and only owners and admins its invitations', async () => {
    const admin = await inOrganization('admin', 'admin');
    const plain = await inOrganization('plain', 'member');
    const view = await (await request(plain.cookie, 'GET', '/organization')).json();
    expect(view).toMatchObject({
      organization: { name: 'Acme', personal: false, joinDomains: [] },
      role: 'member',
    });
    expect(
      view.members.map((row: { email: string; role: string; you: boolean }) => [row.email, row.role, row.you]),
    ).toEqual([
      ['founder@acme.test', 'owner', false],
      ['admin@acme.test', 'admin', false],
      ['plain@acme.test', 'member', true],
    ]);
    expect((await request(plain.cookie, 'GET', '/organization/invitations')).status).toBe(403);
    expect((await request(admin.cookie, 'GET', '/organization/invitations')).status).toBe(200);
  });

  it('invite by single-use link with a role no higher than the inviter may grant', async () => {
    const admin = await inOrganization('admin', 'admin');
    const plain = await inOrganization('plain', 'member');
    expect((await request(plain.cookie, 'POST', '/organization/invitations', { role: 'member' })).status).toBe(403);
    expect((await request(admin.cookie, 'POST', '/organization/invitations', { role: 'owner' })).status).toBe(403);
    for (const body of [undefined, 'not json', {}, { role: 'boss' }, { role: 'member', extra: 1 }])
      expect(
        (await request(admin.cookie, 'POST', '/organization/invitations', body)).status,
        JSON.stringify(body),
      ).toBe(400);
    const created = await request(admin.cookie, 'POST', '/organization/invitations', { role: 'admin' });
    expect(created.status).toBe(201);
    const { invitation } = await created.json();
    expect(invitation.url).toMatch(new RegExp(`^${origin}/join/[A-Za-z0-9_-]{32}$`));
    expect(await db.select({ tokenHash: schema.invitations.tokenHash }).from(schema.invitations)).not.toContainEqual({
      tokenHash: tokenOf(invitation.url),
    });
    expect(await invitationView(db, tokenOf(invitation.url))).toMatchObject({ organization: 'Acme', role: 'admin' });
    const listed = (await (await request(admin.cookie, 'GET', '/organization/invitations')).json()).invitations;
    expect(listed).toEqual([expect.objectContaining({ id: invitation.id, role: 'admin', invitedBy: 'Fixture admin' })]);

    // Someone outside joins with it, and it is used up.
    const newcomer = await signedIn('newcomer', 'newcomer@elsewhere.test');
    expect((await request(newcomer, 'GET', '/organization')).status).toBe(403);
    for (const body of [{}, { token: '' }, { token: 'x'.repeat(101) }])
      expect((await request(newcomer, 'POST', '/invitations/accept', body)).status).toBe(400);
    expect(await (await request(newcomer, 'POST', '/invitations/accept', { token: 'unknown' })).json()).toEqual({
      error: 'invitation_invalid',
    });
    const accepted = await request(newcomer, 'POST', '/invitations/accept', { token: tokenOf(invitation.url) });
    expect(await accepted.json()).toMatchObject({ joined: true, organization: { name: 'Acme' } });
    expect((await (await request(newcomer, 'GET', '/organization')).json()).role).toBe('admin');
    const again = await request(newcomer, 'POST', '/invitations/accept', { token: tokenOf(invitation.url) });
    expect(again.status).toBe(404);
    expect(await invitationView(db, tokenOf(invitation.url))).toBeNull();

    // A member already in keeps the link unused; a revoked or expired one no longer works.
    const second = (await (await request(admin.cookie, 'POST', '/organization/invitations', { role: 'member' })).json())
      .invitation;
    expect((await request(plain.cookie, 'POST', '/invitations/accept', { token: tokenOf(second.url) })).status).toBe(
      409,
    );
    expect(await invitationView(db, tokenOf(second.url))).not.toBeNull();
    expect((await request(plain.cookie, 'DELETE', `/organization/invitations/${second.id}`)).status).toBe(403);
    expect((await request(admin.cookie, 'DELETE', '/organization/invitations/not-an-id')).status).toBe(400);
    expect((await request(admin.cookie, 'DELETE', `/organization/invitations/${second.id}`)).status).toBe(200);
    expect((await request(admin.cookie, 'DELETE', `/organization/invitations/${second.id}`)).status).toBe(404);
    const late = await signedIn('late');
    expect((await request(late, 'POST', '/invitations/accept', { token: tokenOf(second.url) })).status).toBe(404);
    const third = (await (await request(admin.cookie, 'POST', '/organization/invitations', { role: 'member' })).json())
      .invitation;
    await db.update(schema.invitations).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await request(late, 'POST', '/invitations/accept', { token: tokenOf(third.url) })).status).toBe(404);
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
    const patch = (cookie: string, target: Member, role: unknown) =>
      publicIdOf(target).then(id => request(cookie, 'PATCH', `/organization/members/${id}`, { role }));
    expect((await patch(plain.cookie, admin.member, 'member')).status).toBe(403);
    expect((await patch(admin.cookie, plain.member, 'owner')).status).toBe(403);
    expect((await patch(admin.cookie, founder.member, 'member')).status).toBe(403);
    expect((await patch(admin.cookie, plain.member, 'boss')).status).toBe(400);
    expect((await request(admin.cookie, 'PATCH', '/organization/members/mem_x', { role: 'admin' })).status).toBe(400);
    expect(await (await patch(admin.cookie, plain.member, 'admin')).json()).toEqual({ role: 'admin' });
    // The last owner stays one until another is made.
    expect(await (await patch(founder.cookie, founder.member, 'admin')).json()).toEqual({ error: 'last_owner' });
    expect((await patch(founder.cookie, admin.member, 'owner')).status).toBe(200);
    expect((await patch(founder.cookie, founder.member, 'member')).status).toBe(200);
    // Another organization's member is not found.
    await db.insert(schema.user).values({ id: 'other', name: 'Other', email: 'other@b.test', emailVerified: true });
    const elsewhere = await db.transaction(tx =>
      createOrganization(tx, { name: 'B', owner: { id: 'other', name: 'Other', email: 'other@b.test' } }),
    );
    const otherMember = await membership(db, 'other', elsewhere!);
    expect((await patch(admin.cookie, otherMember, 'member')).status).toBe(404);
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
});

describe('switching and creating organizations', () => {
  it('list your organizations, switch only to your own, and act in the one switched to', async () => {
    const { cookie } = await inOrganization('person', 'member');
    expect((await request('', 'GET', '/organizations')).status).toBe(401);
    expect(
      (await request(cookie, 'PUT', '/organizations/current', { organizationId: 'org_x' }, 'https://evil.test')).status,
    ).toBe(403);
    await db.insert(schema.user).values({ id: 'other', name: 'Other', email: 'other@b.test', emailVerified: true });
    const theirs = (await db.transaction(tx =>
      createOrganization(tx, { name: 'Theirs', owner: { id: 'other', name: 'Other', email: 'other@b.test' } }),
    ))!;
    const own = (await db.transaction(tx =>
      createOrganization(tx, { name: 'Own', owner: { id: 'person', name: 'P', email: 'person@acme.test' } }),
    ))!;
    const publicId = async (id: number) =>
      (
        await db
          .select({ publicId: schema.organizations.publicId })
          .from(schema.organizations)
          .where(eq(schema.organizations.id, id))
      )[0]!.publicId;
    const listed = await (await request(cookie, 'GET', '/organizations')).json();
    expect(listed).toEqual({
      organizations: [
        expect.objectContaining({ name: 'Acme', role: 'member', personal: false, current: true }),
        expect.objectContaining({ name: 'Own', role: 'owner', personal: false, current: false }),
      ],
      canCreate: false,
    });
    for (const body of [{}, { organizationId: 'nope' }, { organizationId: 'org_x', extra: 1 }])
      expect((await request(cookie, 'PUT', '/organizations/current', body)).status).toBe(400);
    expect(
      (await request(cookie, 'PUT', '/organizations/current', { organizationId: await publicId(theirs) })).status,
    ).toBe(404);
    const switched = await request(cookie, 'PUT', '/organizations/current', { organizationId: await publicId(own) });
    expect(await switched.json()).toEqual({ current: await publicId(own) });
    expect(await (await request(cookie, 'GET', '/organization')).json()).toMatchObject({
      organization: { name: 'Own' },
      role: 'owner',
    });
  });

  it('create one only where the tenancy offers it, and act in it', async () => {
    const { cookie } = await inOrganization('person', 'member');
    expect((await request(cookie, 'POST', '/organizations', { name: 'Team' })).status).toBe(404);
    let refuse = false;
    tenancy = {
      create: async (tx, owner, name) => (refuse ? null : createOrganization(tx, { name, owner })),
    };
    expect((await (await request(cookie, 'GET', '/organizations')).json()).canCreate).toBe(true);
    expect((await request(cookie, 'POST', '/organizations', { name: 'Team' }, 'https://evil.test')).status).toBe(403);
    for (const body of [{}, { name: '   ' }, { name: 'x'.repeat(101) }, { name: 'Team', extra: 1 }])
      expect((await request(cookie, 'POST', '/organizations', body)).status, JSON.stringify(body)).toBe(400);
    const created = await request(cookie, 'POST', '/organizations', { name: '  Team  ' });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ organization: { id: expect.stringMatching(/^org_/), name: 'Team' } });
    expect(await (await request(cookie, 'GET', '/organization')).json()).toMatchObject({
      organization: { name: 'Team' },
      role: 'owner',
    });
    refuse = true;
    expect(await (await request(cookie, 'POST', '/organizations', { name: 'More' })).json()).toEqual({
      error: 'organization_limit',
    });
  });

  it('act in an organization once you join it', async () => {
    const admin = await inOrganization('admin', 'admin');
    const { invitation } = await (
      await request(admin.cookie, 'POST', '/organization/invitations', { role: 'member' })
    ).json();
    await db.insert(schema.user).values({ id: 'other', name: 'Other', email: 'other@b.test', emailVerified: true });
    await db.transaction(tx =>
      createOrganization(tx, { name: 'Theirs', owner: { id: 'other', name: 'Other', email: 'other@b.test' } }),
    );
    const other = await sessionFor('other');
    expect((await (await request(other, 'GET', '/organization')).json()).organization.name).toBe('Theirs');
    await request(other, 'POST', '/invitations/accept', { token: tokenOf(invitation.url) });
    expect((await (await request(other, 'GET', '/organization')).json()).organization.name).toBe('Acme');
  });
});
