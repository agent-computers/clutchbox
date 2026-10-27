ALTER TABLE "computers" ADD COLUMN "size" text DEFAULT '1x' NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "computer_size" text DEFAULT '1x' NOT NULL;--> statement-breakpoint
ALTER TABLE "computers" ADD CONSTRAINT "computers_size" CHECK ("computers"."size" IN ('1x', '2x', '4x'));--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_computer_size" CHECK ("memberships"."computer_size" IN ('1x', '2x', '4x'));