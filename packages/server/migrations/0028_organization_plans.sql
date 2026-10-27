ALTER TABLE "organizations" ADD COLUMN "plan" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "plan_ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_plan" CHECK ("organizations"."plan" IN ('paid'));