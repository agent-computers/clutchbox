-- Sync data and setup belong to a membership alone. Every row has one, and the code already deployed writes it, so it
-- becomes required. The code deployed with this migration no longer writes user_id, so it becomes optional here and is
-- dropped in a later migration, with its triggers, once no deployed code writes it.
DROP INDEX "captures_user_idx";--> statement-breakpoint
DROP INDEX "connected_browsers_user_idx";--> statement-breakpoint
DROP INDEX "setups_user_idx";--> statement-breakpoint
DROP INDEX "sync_revocations_user_idx";--> statement-breakpoint
DROP INDEX "sync_settings_user_idx";--> statement-breakpoint
ALTER TABLE "captures" ALTER COLUMN "membership_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "connected_browsers" ALTER COLUMN "membership_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "setups" ALTER COLUMN "membership_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_revocations" ALTER COLUMN "membership_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_settings" ALTER COLUMN "membership_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "captures" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connected_browsers" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "setups" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_revocations" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_settings" ALTER COLUMN "user_id" DROP NOT NULL;
