import { relations } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { time } from './columns';
import { user } from './schema';

// Better Auth's organization plugin, over our organizations, memberships, and organization_invitations tables
// (schema.ts): its ID is the row's public_id, and only its own fields exist here, so the integer keys and the app's
// columns (join domains, computer minutes, the personal organization's owner) are out of reach of the auth adapter,
// and of an operator dashboard's generic adapter endpoint. Migrations come from schema.ts alone; these definitions
// name the same tables and never add columns. Joins (advanced.database.joins) go through the relations below, whose
// keys are the plugin's join names: one-to-one by model name, one-to-many plural.
export const authOrganization = pgTable('organizations', {
  id: text('public_id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug'),
  logo: text('logo'),
  metadata: text('metadata'),
  createdAt: time('created_at').notNull(),
});
export const authMember = pgTable('memberships', {
  id: text('public_id').primaryKey(),
  organizationId: text('organization_public_id').notNull(),
  userId: text('user_id').notNull(),
  role: text('role').notNull(),
  createdAt: time('created_at').notNull(),
});
export const authInvitation = pgTable('organization_invitations', {
  id: text('public_id').primaryKey(),
  organizationId: text('organization_public_id').notNull(),
  email: text('email').notNull(),
  role: text('role').notNull(),
  status: text('status').notNull(),
  expiresAt: time('expires_at').notNull(),
  inviterId: text('inviter_id').notNull(),
  createdAt: time('created_at').notNull(),
});
export const authOrganizationRelations = relations(authOrganization, ({ many }) => ({
  members: many(authMember),
  invitations: many(authInvitation),
}));
export const authMemberRelations = relations(authMember, ({ one }) => ({
  organization: one(authOrganization, { fields: [authMember.organizationId], references: [authOrganization.id] }),
  user: one(user, { fields: [authMember.userId], references: [user.id] }),
}));
export const authInvitationRelations = relations(authInvitation, ({ one }) => ({
  organization: one(authOrganization, {
    fields: [authInvitation.organizationId],
    references: [authOrganization.id],
  }),
  user: one(user, { fields: [authInvitation.inviterId], references: [user.id] }),
}));
