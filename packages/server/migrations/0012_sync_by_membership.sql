-- Sync data is read by membership: one capture, revocation, settings row, and setup per membership. The unique user_id
-- on each stays for the code already deployed, whose upserts name it as their conflict target; it goes in a later
-- release.
ALTER TABLE "captures" ADD CONSTRAINT "captures_membership_id_unique" UNIQUE("membership_id");--> statement-breakpoint
ALTER TABLE "setups" ADD CONSTRAINT "setups_membership_id_unique" UNIQUE("membership_id");--> statement-breakpoint
ALTER TABLE "sync_revocations" ADD CONSTRAINT "sync_revocations_membership_id_unique" UNIQUE("membership_id");--> statement-breakpoint
ALTER TABLE "sync_settings" ADD CONSTRAINT "sync_settings_membership_id_unique" UNIQUE("membership_id");--> statement-breakpoint
DROP INDEX "captures_membership_idx";--> statement-breakpoint
DROP INDEX "setups_membership_idx";--> statement-breakpoint
DROP INDEX "sync_revocations_membership_idx";--> statement-breakpoint
DROP INDEX "sync_settings_membership_idx";
