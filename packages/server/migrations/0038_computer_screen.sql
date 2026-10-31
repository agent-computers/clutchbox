ALTER TABLE "computers" ADD COLUMN "screen" text;--> statement-breakpoint
ALTER TABLE "computers" ADD COLUMN "screen_fixed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "computer_screen" text DEFAULT '1440x900' NOT NULL;--> statement-breakpoint
ALTER TABLE "computers" ADD CONSTRAINT "computers_screen" CHECK ("computers"."screen" IN ('1440x900', '1280x1024', '1920x1200'));--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_computer_screen" CHECK ("memberships"."computer_screen" IN ('1440x900', '1280x1024', '1920x1200'));