-- Computers and usage are read by membership: one computer per membership instead of per user, and usage per
-- membership and month. The unique user_id and month on computer_usage stays for the code already deployed, whose
-- charge names it as its conflict target; it goes in the contract step.
ALTER TABLE "computers" ADD CONSTRAINT "computers_membership_id_unique" UNIQUE("membership_id");--> statement-breakpoint
ALTER TABLE "computer_usage" ADD CONSTRAINT "computer_usage_membership_month_unique" UNIQUE("membership_id","month");--> statement-breakpoint
ALTER TABLE "computers" DROP CONSTRAINT "computers_user_id_unique";--> statement-breakpoint
CREATE INDEX "computers_user_idx" ON "computers" USING btree ("user_id");--> statement-breakpoint
DROP INDEX "computer_usage_membership_idx";--> statement-breakpoint
DROP INDEX "computers_membership_idx";
