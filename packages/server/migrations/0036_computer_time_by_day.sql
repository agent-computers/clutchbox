ALTER TABLE "computer_time" ALTER COLUMN "month" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "computer_time" ADD COLUMN "day" date;--> statement-breakpoint
-- Each month's time so far is booked on its first day: whatever period a deployment sums, it begins on a day, and
-- until now every one began on the 1st.
UPDATE "computer_time" SET "day" = "month";--> statement-breakpoint
ALTER TABLE "computer_time" ADD CONSTRAINT "computer_time_day_unique" UNIQUE("membership_id","day","size","account");