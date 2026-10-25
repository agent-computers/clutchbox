ALTER TABLE "computers" ADD COLUMN "runs_until" timestamp with time zone;--> statement-breakpoint
-- billed_until was when the provider would pause the computer, charged ahead; it stays the time booked up to.
-- billed_month is no longer read, and is dropped in the next deploy, once no deployed code selects it.
UPDATE "computers" SET "runs_until" = "billed_until";
