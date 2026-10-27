import { relations, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, key, time, timestamps } from './columns';
import { apikey, oauthClient } from './oauth-schema';

export const user = pgTable('auth_user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  image: text('image'),
  createdAt: time('created_at').defaultNow().notNull(),
  updatedAt: time('updated_at').defaultNow().notNull(),
  // Better Auth admin plugin (operator bans) and dashboard activity tracking.
  role: text('role'),
  banned: boolean('banned').default(false),
  banReason: text('ban_reason'),
  banExpires: time('ban_expires'),
  lastActiveAt: time('last_active_at'),
  // Better Auth's Stripe plugin, for a deployment that bills with it (hooks.ts, AuthPlugins); the product never reads
  // it. The plugin defines it on users even when organizations are its customers.
  stripeCustomerId: text('stripe_customer_id'),
});
// SQL condition: the user is not under a current ban. Bans with a past expiry no longer apply.
export const notBanned = sql`(coalesce(${user.banned}, false) = false or ${user.banExpires} < now())`;
export const session = pgTable(
  'auth_session',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    expiresAt: time('expires_at').notNull(),
    createdAt: time('created_at').defaultNow().notNull(),
    updatedAt: time('updated_at').defaultNow().notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    impersonatedBy: text('impersonated_by'),
    // Better Auth's organization plugin: the organization's public ID its endpoints act in. Kept in step with the
    // person's current membership (organizations.ts, actIn); the plugin checks membership whenever it uses it, so a
    // stale one grants nothing.
    activeOrganizationId: text('active_organization_id'),
  },
  table => [index('auth_session_user_idx').on(table.userId)],
);
export const account = pgTable(
  'auth_account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: time('access_token_expires_at'),
    refreshTokenExpiresAt: time('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: time('created_at').defaultNow().notNull(),
    updatedAt: time('updated_at').defaultNow().notNull(),
  },
  table => [
    unique('auth_provider_account_unique').on(table.providerId, table.accountId),
    index('auth_account_user_idx').on(table.userId),
  ],
);
// Better Auth's adapter joins through these (advanced.database.joins), so a session lookup is one query.
// Key names must match its join names: `user` for one-to-one, plural for one-to-many.
export const userRelations = relations(user, ({ many }) => ({ sessions: many(session), accounts: many(account) }));
export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));
export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}));
export const verification = pgTable(
  'auth_verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: time('expires_at').notNull(),
    createdAt: time('created_at').defaultNow().notNull(),
    updatedAt: time('updated_at').defaultNow().notNull(),
  },
  table => [index('auth_verification_identifier_idx').on(table.identifier)],
);
export const rateLimit = pgTable('auth_rate_limit', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
});
export const installation = pgTable(
  'installation',
  {
    id: text('id').primaryKey().default('singleton'),
    dataClass: text('data_class').notNull(),
  },
  table => [
    check('installation_singleton', sql`${table.id} = 'singleton'`),
    check('installation_data_class', sql`${table.dataClass} IN ('production', 'nonproduction')`),
  ],
);

export * from './oauth-schema';

// CHECK for a state column: the list is also the column's TypeScript type.
const oneOf = (column: AnyPgColumn, values: readonly string[]) =>
  sql`${column} IN (${sql.raw(values.map(value => `'${value}'`).join(', '))})`;

// An IANA zone name's characters only: it becomes a path on the computer (time-zones.ts checks the zone exists).
const timeZoneName = (column: AnyPgColumn) => sql`${column} ~ '^[A-Za-z][A-Za-z0-9_+/-]{0,63}$'`;
export const MEMBER_ROLES = ['owner', 'admin', 'member'] as const;
// The plans a deployment may put an organization on (organizations.plan).
export const ORGANIZATION_PLANS = ['paid'] as const;
// An organization: the tenant whose members sync to it and whose agents use their computers (organizations.ts). A
// personal organization records the person it was made for, so each person has at most one; a deployment that serves
// one organization leaves it null. joinDomains: email domains whose people may join it themselves (members.ts),
// lowercase. Better Auth's organization plugin sees this table through auth-schema.ts: public_id is its ID, and slug,
// logo, and metadata are its fields.
export const organizations = pgTable(
  'organizations',
  {
    id: id(),
    publicId: text('public_id').notNull().unique(),
    name: text('name').notNull(),
    // Better Auth's: unique; nothing shows it.
    slug: text('slug').notNull().unique(),
    logo: text('logo'),
    metadata: text('metadata'),
    personalUserId: text('personal_user_id')
      .unique()
      .references(() => user.id, { onDelete: 'cascade' }),
    joinDomains: text('join_domains').array().notNull().default(sql`'{}'::text[]`),
    // Computer minutes a month the deployment allows this organization, for its metering hook; null for its default.
    computerMinutes: integer('computer_minutes'),
    // Forks that may run at once across the organization's members (computers.ts, openComputerSession); null for the
    // deployment's limit (hooks.ts, Limits.runningForks), else DEFAULT_MAX_RUNNING_FORKS.
    maxRunningForks: integer('max_running_forks'),
    // The plan a deployment's operators put the organization on, which its hooks read: 'paid', or null for the
    // deployment's default. The product itself has no plans. plan_ended_at is when the last one ended, for what the
    // deployment keeps after.
    plan: text('plan', { enum: ORGANIZATION_PLANS }),
    planEndedAt: time('plan_ended_at'),
    // The organization's customer in Better Auth's Stripe plugin, for a deployment that bills with it.
    stripeCustomerId: text('stripe_customer_id'),
    ...timestamps(),
  },
  table => [
    check('organizations_name', sql`char_length(${table.name}) BETWEEN 1 AND 100`),
    check('organizations_computer_minutes', sql`${table.computerMinutes} >= 0`),
    check('organizations_max_running_forks', sql`${table.maxRunningForks} >= 0`),
    check('organizations_plan', oneOf(table.plan, ORGANIZATION_PLANS)),
  ],
);
// A person's place in one organization. Every app table below belongs to one, as membership_id, except user_settings,
// which is the person's in every organization. Better Auth's organization plugin sees it through auth-schema.ts, as
// its member: public_id is its ID, and the organization is referenced by its public ID, the one key the plugin knows.
export const memberships = pgTable(
  'memberships',
  {
    id: id(),
    publicId: text('public_id').notNull().unique(),
    organizationId: text('organization_public_id')
      .notNull()
      .references(() => organizations.publicId, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role', { enum: MEMBER_ROLES }).notNull(),
    ...timestamps(),
  },
  table => [
    unique('memberships_organization_user_unique').on(table.organizationId, table.userId),
    index('memberships_user_idx').on(table.userId),
    check('memberships_role', oneOf(table.role, MEMBER_ROLES)),
  ],
);
export const INVITATION_STATUSES = ['pending', 'accepted', 'rejected', 'canceled'] as const;
// An invitation to join an organization with a role, for one email address: Better Auth's organization plugin's
// invitation (auth-schema.ts), which only an account with that verified address accepts. Its lifecycle is the plugin's
// status rather than *_at columns.
export const organizationInvitations = pgTable(
  'organization_invitations',
  {
    id: id(),
    publicId: text('public_id').notNull().unique(),
    organizationId: text('organization_public_id')
      .notNull()
      .references(() => organizations.publicId, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role', { enum: MEMBER_ROLES }).notNull(),
    status: text('status', { enum: INVITATION_STATUSES }).notNull(),
    expiresAt: time('expires_at').notNull(),
    inviterId: text('inviter_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  table => [
    index('organization_invitations_organization_idx').on(table.organizationId),
    index('organization_invitations_inviter_idx').on(table.inviterId),
    index('organization_invitations_email_idx').on(table.email),
    check('organization_invitations_role', oneOf(table.role, MEMBER_ROLES)),
    check('organization_invitations_status', oneOf(table.status, INVITATION_STATUSES)),
  ],
);
// What an organization API key may do (api-keys.ts), as its permissions. captures: read any member's latest capture;
// computers: open computer sessions for any member, on forks of their computer, and drive them over CDP.
export const API_KEY_SCOPES = ['captures', 'computers'] as const;
// A person connected to an organization's app through Connect (connect.ts): the app's OAuth client, the member, and
// the app's own ID for them. It goes with either.
export const connections = pgTable(
  'connections',
  {
    id: id(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    membershipId: key('membership_id')
      .notNull()
      .references(() => memberships.id, { onDelete: 'cascade' }),
    externalUserId: text('external_user_id'),
    ...timestamps(),
  },
  table => [
    unique('connections_client_membership_unique').on(table.clientId, table.membershipId),
    index('connections_membership_idx').on(table.membershipId),
    check('connections_external_user_id', sql`char_length(${table.externalUserId}) BETWEEN 1 AND 255`),
  ],
);
// The membership a per-user row belongs to; see memberships.
const membershipId = () => key('membership_id').references(() => memberships.id, { onDelete: 'cascade' });

export const COMPUTER_STATUSES = ['creating', 'ready'] as const;
// A member's computers: one persistent main computer, changed only by the member's takeover, and the forks agents
// work in, each a copy of main from one of its snapshots (computers.ts, Forks). Agents never control main.
export const computers = pgTable(
  'computers',
  {
    id: id(),
    // Also the provider's idempotency key and the applied capture's associated data, so it never changes. A fork's is
    // the opaque ID agents reopen it by.
    publicId: text('public_id').notNull().unique(),
    membershipId: membershipId().notNull(),
    // A fork's main computer; null on main.
    forkOf: key('fork_of').references((): AnyPgColumn => computers.id, { onDelete: 'cascade' }),
    // Main: its latest snapshot, which new forks start from. A fork: the snapshot it was made from, which the provider
    // keeps until the fork is deleted.
    snapshotId: key('snapshot_id').references((): AnyPgColumn => computerSnapshots.id, { onDelete: 'set null' }),
    // Main: when a takeover ended after its latest snapshot, so the next fork needs a new one first.
    snapshotDueAt: time('snapshot_due_at'),
    // A fork's name from the agent that made it, for computer_list.
    label: text('label'),
    // A fork's latest open or call; one unused for FORK_UNUSED_MS is deleted.
    lastUsedAt: time('last_used_at'),
    status: text('status', { enum: COMPUTER_STATUSES }).notNull().default('creating'),
    sandboxId: text('sandbox_id'),
    // Before profiles, the one apply baseline (computer_profiles has one per profile). Read and written only by code
    // deployed before them; dropped in a later release.
    appliedCaptureDigest: text('applied_capture_digest'),
    appliedCaptureAt: time('applied_capture_at'),
    syncedSites: text('synced_sites').array().notNull().default(sql`'{}'::text[]`),
    appliedCapture: text('applied_capture'),
    // Allowance metering (computers.ts, meter): when the provider will pause the computer unless called again, and
    // the time its running is booked up to.
    runsUntil: time('runs_until'),
    billedUntil: time('billed_until'),
    // Calls in flight on this computer (computers.ts): ID → its session (computer_sessions.id) and deadline.
    // Denormalized: it changes only with the computer row locked, together with the pause decision. A call's
    // end lets the computer pause only once no other call is in flight; an entry past its deadline no longer
    // counts, so a call whose end was lost (a killed function) holds the computer no longer than its deadline.
    callsInFlight: jsonb('calls_in_flight')
      .$type<Record<string, { sessionId: number; until: string }>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    // The system time zone last set on the computer (computers.ts, applyTimeZone); null is the template's UTC.
    timeZone: text('time_zone'),
    // The helper revision the computer was last brought to (computers.ts, refreshComputer); null until an open
    // checks it. Lets an open skip the check once the computer is current.
    revision: text('revision'),
    // Live view (computers.ts, Live view holds). The user's takeover: the page load (lease) holding it, when it
    // started, and when it lapses unless a heartbeat extends it. It counts only while takeover_until is ahead;
    // a lapsed one is ended lazily. Typed, since the relay reads it for every input decision.
    takeoverLease: uuid('takeover_lease'),
    takenOverAt: time('taken_over_at'),
    takeoverUntil: time('takeover_until'),
    // Pages watching the computer: lease → when the watch lapses unless a heartbeat extends it. Denormalized like
    // callsInFlight: it changes only with the computer row locked, together with the pause decision, and each
    // open page keeps its own deadline, so one tab's release never cuts another's watch short. An entry past its
    // deadline no longer counts. A released lease keeps `{ released }` for a short while, so a heartbeat still in
    // flight when its page closed starts no new watch.
    liveViewWatches: jsonb('live_view_watches')
      .$type<Record<string, string | { released: string }>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...timestamps(),
  },
  table => [
    uniqueIndex('computers_main_unique').on(table.membershipId).where(sql`${table.forkOf} IS NULL`),
    index('computers_membership_idx').on(table.membershipId),
    index('computers_fork_of_idx').on(table.forkOf),
    index('computers_snapshot_idx').on(table.snapshotId),
    check('computers_status', oneOf(table.status, COMPUTER_STATUSES)),
    check('computers_label', sql`char_length(${table.label}) BETWEEN 1 AND 100`),
    check(
      'computers_fork',
      sql`${table.forkOf} IS NULL OR (${table.snapshotDueAt} IS NULL AND ${table.lastUsedAt} IS NOT NULL)`,
    ),
    check('computers_time_zone', timeZoneName(table.timeZone)),
    check(
      'computers_takeover',
      sql`(${table.takeoverLease} IS NULL) = (${table.takenOverAt} IS NULL) AND (${table.takenOverAt} IS NULL) = (${table.takeoverUntil} IS NULL)`,
    ),
  ],
);
// Snapshots of a main computer (computers.ts, Forks), each with what main had applied when it was taken, which a fork
// made from it starts with: its profiles' apply baselines (computer_profiles), helper revision, and time zone. Kept
// while main's latest or while a fork made from it remains, since the provider refuses to delete a snapshot before
// that; then deleted at the provider and here. The applied_capture columns are from before profiles, like computers'.
export const computerSnapshots = pgTable(
  'computer_snapshots',
  {
    id: id(),
    computerId: key('computer_id')
      .notNull()
      .references((): AnyPgColumn => computers.id, { onDelete: 'cascade' }),
    providerSnapshotId: text('provider_snapshot_id').notNull().unique(),
    appliedCaptureDigest: text('applied_capture_digest'),
    appliedCaptureAt: time('applied_capture_at'),
    syncedSites: text('synced_sites').array().notNull().default(sql`'{}'::text[]`),
    appliedCapture: text('applied_capture'),
    timeZone: text('time_zone'),
    revision: text('revision'),
    createdAt: createdAt(),
  },
  table => [index('computer_snapshots_computer_idx').on(table.computerId)],
);
// A connected browser's Chrome profile on one of the member's computers, or as a snapshot of main had it (computers.ts,
// Profiles): its directory there (chrome_profile, the provider's profile name), the last capture of the browser's
// applied to it, the sites that wrote (cleared when absent later), and its cookies sealed (captures.ts,
// sealAppliedCapture, for the computer's public ID; a snapshot's for main's) as the baseline the next apply diffs
// against. A null baseline makes the next apply replace each target site wholesale. Kept once the browser stops
// syncing, so the next open can clear its sites and nobody else gets its directory.
export const computerProfiles = pgTable(
  'computer_profiles',
  {
    id: id(),
    computerId: key('computer_id').references((): AnyPgColumn => computers.id, { onDelete: 'cascade' }),
    snapshotId: key('snapshot_id').references((): AnyPgColumn => computerSnapshots.id, { onDelete: 'cascade' }),
    connectedBrowserId: key('connected_browser_id')
      .notNull()
      .references((): AnyPgColumn => connectedBrowsers.id, { onDelete: 'cascade' }),
    chromeProfile: text('chrome_profile').notNull(),
    appliedCaptureDigest: text('applied_capture_digest'),
    appliedCaptureAt: time('applied_capture_at'),
    syncedSites: text('synced_sites').array().notNull().default(sql`'{}'::text[]`),
    appliedCapture: text('applied_capture'),
    ...timestamps(),
  },
  table => [
    unique('computer_profiles_computer_browser_unique').on(table.computerId, table.connectedBrowserId),
    unique('computer_profiles_computer_chrome_profile_unique').on(table.computerId, table.chromeProfile),
    unique('computer_profiles_snapshot_browser_unique').on(table.snapshotId, table.connectedBrowserId),
    index('computer_profiles_connected_browser_idx').on(table.connectedBrowserId),
    check('computer_profiles_owner', sql`(${table.computerId} IS NULL) <> (${table.snapshotId} IS NULL)`),
    check('computer_profiles_chrome_profile', sql`${table.chromeProfile} ~ '^[a-z0-9_]{1,64}$'`),
  ],
);
// superseded: another agent's computer_open replaced this session after its idle minute.
export const SESSION_END_REASONS = ['closed', 'idle', 'superseded', 'replaced', 'revoked'] as const;
// Computer sessions: a server-issued public ID that works only for the member and the agent that opened it: an MCP
// client (OAuth client_id) or an organization API key (api_key_id), exactly one of them, on one profile (the connected
// browser's; null with none, and on sessions from before profiles). At most one is live per computer. `lastCallAt` is when the latest call ended; a call in
// flight writes its deadline. A user's takeover suspends the live session: `suspendedAt` stops its idle
// clock, and the resume shifts `lastCallAt` past the suspension and sets `handedBackAt`, which its next call
// reports to the agent and clears.
export const computerSessions = pgTable(
  'computer_sessions',
  {
    id: id(),
    publicId: text('public_id').notNull().unique(),
    membershipId: membershipId().notNull(),
    clientId: text('client_id').references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    apiKeyId: text('api_key_id').references(() => apikey.id, { onDelete: 'cascade' }),
    computerId: key('computer_id')
      .notNull()
      .references(() => computers.id, { onDelete: 'cascade' }),
    connectedBrowserId: key('connected_browser_id').references((): AnyPgColumn => connectedBrowsers.id, {
      onDelete: 'set null',
    }),
    // The SHA-256 of the secret in a REST session's CDP URL (computers.ts, CDP); null for MCP's.
    cdpTokenHash: text('cdp_token_hash').unique(),
    lastCallAt: time('last_call_at').notNull(),
    endedAt: time('ended_at'),
    endReason: text('end_reason', { enum: SESSION_END_REASONS }),
    suspendedAt: time('suspended_at'),
    handedBackAt: time('handed_back_at'),
    ...timestamps(),
  },
  table => [
    index('computer_sessions_membership_idx').on(table.membershipId),
    uniqueIndex('computer_sessions_live_unique').on(table.computerId).where(sql`${table.endedAt} IS NULL`),
    index('computer_sessions_computer_idx').on(table.computerId),
    index('computer_sessions_client_idx').on(table.clientId),
    index('computer_sessions_api_key_idx').on(table.apiKeyId),
    index('computer_sessions_connected_browser_idx').on(table.connectedBrowserId),
    check('computer_sessions_agent', sql`(${table.clientId} IS NULL) <> (${table.apiKeyId} IS NULL)`),
    check('computer_sessions_end_reason', oneOf(table.endReason, SESSION_END_REASONS)),
    check('computer_sessions_ended', sql`(${table.endedAt} IS NULL) = (${table.endReason} IS NULL)`),
  ],
);
// download: only on calls recorded before computer_download was removed.
export const TOOL_CALL_STEPS = [
  'snapshot',
  'create',
  'connect',
  'sync',
  'screenshot',
  'act',
  'cdp',
  'exec',
  'download',
] as const;
// One row per MCP tool call (tool-calls.ts): operational facts only, never the call's arguments or results.
// `error` is null for a successful call, otherwise the code the agent got. For a call with an error,
// `failedStep` is the last step it reached; `errorClass` is the class of what it threw, if anything.
export const toolCalls = pgTable(
  'tool_calls',
  {
    id: id(),
    membershipId: membershipId().notNull(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    computerSessionId: key('computer_session_id').references(() => computerSessions.id, { onDelete: 'set null' }),
    tool: text('tool').notNull(),
    startedAt: time('started_at').notNull(),
    endedAt: time('ended_at').notNull(),
    error: text('error'),
    failedStep: text('failed_step', { enum: TOOL_CALL_STEPS }),
    errorClass: text('error_class'),
    createdAt: createdAt(),
  },
  table => [
    index('tool_calls_membership_idx').on(table.membershipId),
    index('tool_calls_started_idx').on(table.startedAt),
    index('tool_calls_client_idx').on(table.clientId),
    index('tool_calls_computer_session_idx').on(table.computerSessionId),
    check('tool_calls_failed_step', oneOf(table.failedStep, TOOL_CALL_STEPS)),
    // Codes and class names only, so no argument or result text can land here.
    check('tool_calls_error', sql`${table.error} ~ '^[a-z][a-z_]{0,39}$'`),
    check('tool_calls_error_class', sql`char_length(${table.errorClass}) <= 100`),
  ],
);

export const BROWSER_NAMES = ['chrome', 'edge', 'opera'] as const;
export const BROWSER_PLATFORMS = ['macos', 'windows', 'linux', 'chromeos'] as const;
// A browser connected with OAuth: one Better Auth refresh-token family (browsers.ts), signed in to one person's
// account, which syncs to each of their organizations it has sites for (browser_memberships). created_at is when it
// connected.
export const connectedBrowsers = pgTable(
  'connected_browsers',
  {
    id: id(),
    publicId: text('public_id').notNull().unique(),
    // Null only on rows written before browsers belonged to the person; the migration fills those.
    userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
    // The membership the person acted in when it connected: where builds that name no organization sync. Leaving it
    // clears it rather than signing the browser out of the person's other organizations.
    membershipId: key('membership_id').references(() => memberships.id, { onDelete: 'set null' }),
    // oauth_refresh_token.authorization_code_id: stable across rotation, but not a key there, so no foreign key.
    authorizationCodeId: text('authorization_code_id').notNull().unique(),
    // From the User-Agent at first use; null when unknown, and cleared on sign-out.
    browser: text('browser', { enum: BROWSER_NAMES }),
    platform: text('platform', { enum: BROWSER_PLATFORMS }),
    lastSyncedAt: time('last_synced_at'),
    // Tombstone of signing out: the family never syncs again, even when a racing rotation recreates its tokens.
    disconnectedAt: time('disconnected_at'),
    ...timestamps(),
  },
  table => [
    index('connected_browsers_user_idx').on(table.userId),
    index('connected_browsers_membership_idx').on(table.membershipId),
    check('connected_browsers_browser', oneOf(table.browser, BROWSER_NAMES)),
    check('connected_browsers_platform', oneOf(table.platform, BROWSER_PLATFORMS)),
  ],
);
// A connected browser in one of the person's organizations: recorded at its first upload there, and listed on that
// organization's Browser sync page. removed_at: removed there (one browser, or Delete everything), so its uploads
// are refused until the person adds a site there again in the extension.
export const browserMemberships = pgTable(
  'browser_memberships',
  {
    id: id(),
    connectedBrowserId: key('connected_browser_id')
      .notNull()
      .references(() => connectedBrowsers.id, { onDelete: 'cascade' }),
    membershipId: membershipId().notNull(),
    lastSyncedAt: time('last_synced_at'),
    removedAt: time('removed_at'),
    ...timestamps(),
  },
  table => [
    unique('browser_memberships_browser_membership_unique').on(table.connectedBrowserId, table.membershipId),
    index('browser_memberships_membership_idx').on(table.membershipId),
  ],
);

// The latest capture of each connected browser in each organization it syncs to: the browser's profile there
// (computers.ts, Profiles). Sealed with AES-256-GCM (sealing.ts), with the membership as associated data; only the
// digest and counts are plaintext, and cookies and the site list stay sealed. Deleted when the browser signs out or is
// removed there.
export const browserCaptures = pgTable(
  'browser_captures',
  {
    id: id(),
    membershipId: membershipId().notNull(),
    connectedBrowserId: key('connected_browser_id')
      .notNull()
      .references(() => connectedBrowsers.id, { onDelete: 'cascade' }),
    // The extension's ID for this capture.
    captureId: uuid('capture_id').notNull(),
    digest: text('digest').notNull(),
    cookieCount: integer('cookie_count').notNull(),
    sealed: text('sealed').notNull(),
    // The capture's scope ({mode, sites}, no exclusions) sealed on its own, so the account page can list synced sites
    // without opening the whole capture. Null on rows stored before it existed.
    sealedScope: text('sealed_scope'),
    completedAt: time('completed_at').notNull(),
    // Server receive time of the latest upload, changed or not: orders uploads, and the latest is the default profile.
    uploadedAt: time('uploaded_at').defaultNow().notNull(),
    ...timestamps(),
  },
  table => [
    unique('browser_captures_membership_browser_unique').on(table.membershipId, table.connectedBrowserId),
    index('browser_captures_connected_browser_idx').on(table.connectedBrowserId),
  ],
);
// Before profiles, the latest capture per member, which browser_captures replaces. Read and written only by code
// deployed before profiles; dropped in a later release.
export const captures = pgTable(
  'captures',
  {
    id: id(),
    membershipId: membershipId().notNull().unique(),
    // The extension's ID for this capture.
    captureId: uuid('capture_id').notNull(),
    digest: text('digest').notNull(),
    cookieCount: integer('cookie_count').notNull(),
    sealed: text('sealed').notNull(),
    // The capture's scope ({mode, sites}, no exclusions) sealed on its own, so /account can list
    // synced sites without opening the whole capture. Null on rows stored before it existed.
    sealedScope: text('sealed_scope'),
    completedAt: time('completed_at').notNull(),
    // Server receive time of the latest upload; orders uploads against deletions.
    uploadedAt: time('uploaded_at').defaultNow().notNull(),
    // The browser that sent the latest upload; null on uploads from extension builds before OAuth.
    connectedBrowserId: key('connected_browser_id').references(() => connectedBrowsers.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  table => [index('captures_connected_browser_idx').on(table.connectedBrowserId)],
);
// Last capture deletion per member: uploads received before it are refused. `disconnected`
// (dashboard Delete everything) refuses all uploads until the extension reconnects.
export const syncRevocations = pgTable('sync_revocations', {
  id: id(),
  membershipId: membershipId().notNull().unique(),
  deletedAt: time('deleted_at').notNull(),
  disconnected: boolean('disconnected').notNull().default(false),
  ...timestamps(),
});
// Browser sync settings per member: added sites, exclusions, and pause, sealed like the
// capture (sealing.ts). The extension adopts them; the account page edits them.
export const syncSettings = pgTable('sync_settings', {
  id: id(),
  membershipId: membershipId().notNull().unique(),
  sealed: text('sealed').notNull(),
  ...timestamps(),
});
// Computer seconds charged per member per UTC calendar month, against the free allowance.
export const computerUsage = pgTable(
  'computer_usage',
  {
    id: id(),
    membershipId: membershipId().notNull(),
    month: date('month', { mode: 'string' }).notNull(),
    usedSeconds: integer('used_seconds').notNull().default(0),
    ...timestamps(),
  },
  table => [unique('computer_usage_membership_month_unique').on(table.membershipId, table.month)],
);
// Setup progress, one row per member. First-completion times and
// firstSetUpAt are never cleared, so they record the funnel; Delete everything clears only
// setUpAt and noticeClosedAt. `preexisting`: the user existed before setup shipped (no events).
export const setups = pgTable('setups', {
  id: id(),
  membershipId: membershipId().notNull().unique(),
  preexisting: boolean('preexisting').notNull().default(false),
  browserSyncedAt: time('browser_synced_at'),
  // The earliest live consent's createdAt.
  agentConnectedAt: time('agent_connected_at'),
  firstSetUpAt: time('first_set_up_at'),
  setUpAt: time('set_up_at'),
  noticeClosedAt: time('notice_closed_at'),
  ...timestamps(),
});
// Per-user app preferences, kept off Better Auth's tables.
export const userSettings = pgTable(
  'user_settings',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: 'cascade' }),
    // When the user asked to hear about developer plans; null when they have not, or turned it off.
    developerUpdatesAt: time('developer_updates_at'),
    // The IANA time zone the user's browser last reported (time-zones.ts); their computer follows it.
    timeZone: text('time_zone'),
    // The membership the person last switched to (organizations.ts, currentMember); null for their oldest.
    currentMembershipId: key('current_membership_id').references(() => memberships.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  table => [
    check('user_settings_time_zone', timeZoneName(table.timeZone)),
    index('user_settings_current_membership_idx').on(table.currentMembershipId),
  ],
);

// Better Auth's Stripe plugin's subscriptions (its `subscription` model), for a deployment that bills organizations
// with it (hooks.ts, AuthPlugins): the plugin writes them from Stripe's webhooks, and only the deployment's hooks read
// them. Its own text IDs, like the other Better Auth tables.
export const BILLING_SUBSCRIPTION_STATUSES = [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
] as const;
export const billingSubscriptions = pgTable(
  'billing_subscriptions',
  {
    id: text('id').primaryKey(),
    plan: text('plan').notNull(),
    referenceId: text('reference_id')
      .notNull()
      .references(() => organizations.publicId, { onDelete: 'cascade' }),
    stripeCustomerId: text('stripe_customer_id'),
    stripeSubscriptionId: text('stripe_subscription_id'),
    status: text('status').notNull().default('incomplete'),
    periodStart: time('period_start'),
    periodEnd: time('period_end'),
    trialStart: time('trial_start'),
    trialEnd: time('trial_end'),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').default(false),
    cancelAt: time('cancel_at'),
    canceledAt: time('canceled_at'),
    endedAt: time('ended_at'),
    seats: integer('seats'),
    billingInterval: text('billing_interval'),
    stripeScheduleId: text('stripe_schedule_id'),
    ...timestamps(),
  },
  table => [
    index('billing_subscriptions_reference_id_idx').on(table.referenceId),
    index('billing_subscriptions_stripe_subscription_id_idx').on(table.stripeSubscriptionId),
    check('billing_subscriptions_status', oneOf(table.status, BILLING_SUBSCRIPTION_STATUSES)),
  ],
);
