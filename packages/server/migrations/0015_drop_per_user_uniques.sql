-- Contracts the per-user uniqueness the code before membership-scoped sync relied on: no deployed code names these
-- constraints any more, so a person can have a capture, settings, revocation, and setup in each membership. user_id
-- keeps a plain index for its foreign key until it goes.
CREATE INDEX "captures_user_idx" ON "captures" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "setups_user_idx" ON "setups" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sync_revocations_user_idx" ON "sync_revocations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sync_settings_user_idx" ON "sync_settings" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "captures" DROP CONSTRAINT "captures_user_id_unique";--> statement-breakpoint
ALTER TABLE "setups" DROP CONSTRAINT "setups_user_id_unique";--> statement-breakpoint
ALTER TABLE "sync_revocations" DROP CONSTRAINT "sync_revocations_user_id_unique";--> statement-breakpoint
ALTER TABLE "sync_settings" DROP CONSTRAINT "sync_settings_user_id_unique";
