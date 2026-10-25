-- Rename taken_over to superseded, deploy 2 of 2 (0005 was deploy 1): renames any row the code before 0005 wrote
-- during that deploy, then drops taken_over from the CHECK.
UPDATE "computer_sessions" SET "end_reason" = 'superseded' WHERE "end_reason" = 'taken_over';--> statement-breakpoint
ALTER TABLE "computer_sessions" DROP CONSTRAINT "computer_sessions_end_reason";--> statement-breakpoint
ALTER TABLE "computer_sessions" ADD CONSTRAINT "computer_sessions_end_reason" CHECK ("computer_sessions"."end_reason" IN ('closed', 'idle', 'superseded', 'replaced', 'revoked'));