ALTER TABLE "computer_sessions" DROP CONSTRAINT "computer_sessions_end_reason";--> statement-breakpoint
ALTER TABLE "computer_sessions" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "computer_sessions" ADD COLUMN "handed_back_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "computers" ADD COLUMN "takeover_lease" uuid;--> statement-breakpoint
ALTER TABLE "computers" ADD COLUMN "taken_over_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "computers" ADD COLUMN "takeover_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "computers" ADD COLUMN "live_view_watches" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "computer_sessions" ADD CONSTRAINT "computer_sessions_end_reason" CHECK ("computer_sessions"."end_reason" IN ('closed', 'idle', 'superseded', 'replaced', 'revoked', 'taken_over'));--> statement-breakpoint
ALTER TABLE "computers" ADD CONSTRAINT "computers_takeover" CHECK (("computers"."takeover_lease" IS NULL) = ("computers"."taken_over_at" IS NULL) AND ("computers"."taken_over_at" IS NULL) = ("computers"."takeover_until" IS NULL));--> statement-breakpoint
-- Rename taken_over to superseded, deploy 1 of 2: the CHECK above allows both while code already deployed may
-- still write taken_over; the next deploy repeats this update and drops taken_over from the CHECK.
UPDATE "computer_sessions" SET "end_reason" = 'superseded' WHERE "end_reason" = 'taken_over';
