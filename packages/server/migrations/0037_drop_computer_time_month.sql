ALTER TABLE "computer_time" DROP CONSTRAINT "computer_time_month_unique";--> statement-breakpoint
-- Rows the code before 0036 booked while it deployed have only a month; its first day is where 0036 put the rest.
UPDATE "computer_time" SET "day" = "month" WHERE "day" IS NULL;--> statement-breakpoint
ALTER TABLE "computer_time" ALTER COLUMN "day" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "computer_time" DROP COLUMN "month";