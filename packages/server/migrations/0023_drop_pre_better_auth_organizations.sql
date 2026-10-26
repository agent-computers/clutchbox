-- Contract step for organizations on Better Auth: the code already deployed neither reads nor writes the old
-- invitations and api_keys tables or memberships.organization_id, and every membership has its organization's public
-- ID, so they go, with the trigger that filled the public ID for the release before. Dropping a column drops its
-- foreign key. Every organization has a slug, which the code already deployed always sets.
DROP TRIGGER "memberships_fill_organization_public_id" ON "memberships";--> statement-breakpoint
DROP FUNCTION "memberships_fill_organization_public_id"();--> statement-breakpoint
ALTER TABLE "memberships" DROP COLUMN "organization_id";--> statement-breakpoint
DROP TABLE "invitations";--> statement-breakpoint
DROP TABLE "api_keys";--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "slug" SET NOT NULL;
