-- Contract step for computers, computer sessions, tool calls, and usage: the code already deployed neither reads nor
-- writes user_id there, and every row has its membership, so the column goes with the trigger that filled
-- membership_id from it. Dropping a column drops its foreign key.
DROP TRIGGER "computers_membership_on_insert" ON "computers";--> statement-breakpoint
DROP TRIGGER "computer_sessions_membership_on_insert" ON "computer_sessions";--> statement-breakpoint
DROP TRIGGER "tool_calls_membership_on_insert" ON "tool_calls";--> statement-breakpoint
DROP TRIGGER "computer_usage_membership_on_insert" ON "computer_usage";--> statement-breakpoint
ALTER TABLE "computers" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "computer_sessions" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "tool_calls" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "computer_usage" DROP COLUMN "user_id";
