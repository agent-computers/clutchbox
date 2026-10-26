ALTER TABLE "organizations" ADD COLUMN "computer_minutes" integer;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "current_membership_id" bigint;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_current_membership_id_memberships_id_fk" FOREIGN KEY ("current_membership_id") REFERENCES "public"."memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_settings_current_membership_idx" ON "user_settings" USING btree ("current_membership_id");--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_computer_minutes" CHECK ("organizations"."computer_minutes" >= 0);