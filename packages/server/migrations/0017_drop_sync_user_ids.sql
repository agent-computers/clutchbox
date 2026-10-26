-- Contract step for sync data and setup: the code already deployed neither reads nor writes user_id there, and every
-- row has its membership, so the column goes with the trigger that filled membership_id from it, and with the
-- trigger function, which no table uses any more. Dropping a column drops its foreign key.
DROP TRIGGER "connected_browsers_membership_on_insert" ON "connected_browsers";--> statement-breakpoint
DROP TRIGGER "captures_membership_on_insert" ON "captures";--> statement-breakpoint
DROP TRIGGER "sync_revocations_membership_on_insert" ON "sync_revocations";--> statement-breakpoint
DROP TRIGGER "sync_settings_membership_on_insert" ON "sync_settings";--> statement-breakpoint
DROP TRIGGER "setups_membership_on_insert" ON "setups";--> statement-breakpoint
DROP FUNCTION set_membership_from_user();--> statement-breakpoint
ALTER TABLE "connected_browsers" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "captures" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "sync_revocations" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "sync_settings" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "setups" DROP COLUMN "user_id";
