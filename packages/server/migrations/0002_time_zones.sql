ALTER TABLE "computers" ADD COLUMN "time_zone" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "time_zone" text;--> statement-breakpoint
ALTER TABLE "computers" ADD CONSTRAINT "computers_time_zone" CHECK ("computers"."time_zone" ~ '^[A-Za-z][A-Za-z0-9_+/-]{0,63}$');--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_time_zone" CHECK ("user_settings"."time_zone" ~ '^[A-Za-z][A-Za-z0-9_+/-]{0,63}$');