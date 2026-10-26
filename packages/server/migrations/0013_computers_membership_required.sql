-- Computers, computer sessions, tool calls, and usage belong to a membership alone. Every row has one, and the code
-- already deployed writes it, so it becomes required. The code deployed with this migration no longer writes user_id,
-- so it becomes optional here and is dropped in a later migration, with its triggers, once no deployed code writes it.
-- The unique user_id and month on computer_usage goes now: the code already deployed charges by membership and month.
ALTER TABLE "computer_usage" DROP CONSTRAINT "computer_usage_user_month_unique";--> statement-breakpoint
DROP INDEX "computer_sessions_user_client_idx";--> statement-breakpoint
DROP INDEX "computers_user_idx";--> statement-breakpoint
DROP INDEX "tool_calls_user_started_idx";--> statement-breakpoint
ALTER TABLE "computer_sessions" ALTER COLUMN "membership_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "computer_usage" ALTER COLUMN "membership_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "computers" ALTER COLUMN "membership_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_calls" ALTER COLUMN "membership_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "computer_sessions" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "computer_usage" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "computers" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_calls" ALTER COLUMN "user_id" DROP NOT NULL;
