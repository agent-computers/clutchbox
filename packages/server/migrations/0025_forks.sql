CREATE TABLE "computer_snapshots" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "computer_snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"computer_id" bigint NOT NULL,
	"provider_snapshot_id" text NOT NULL,
	"applied_capture_digest" text,
	"applied_capture_at" timestamp with time zone,
	"synced_sites" text[] DEFAULT '{}'::text[] NOT NULL,
	"applied_capture" text,
	"time_zone" text,
	"revision" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "computer_snapshots_provider_snapshot_id_unique" UNIQUE("provider_snapshot_id")
);
--> statement-breakpoint
ALTER TABLE "computers" DROP CONSTRAINT "computers_membership_id_unique";--> statement-breakpoint
ALTER TABLE "tool_calls" DROP CONSTRAINT "tool_calls_failed_step";--> statement-breakpoint
ALTER TABLE "computers" ADD COLUMN "fork_of" bigint;--> statement-breakpoint
ALTER TABLE "computers" ADD COLUMN "snapshot_id" bigint;--> statement-breakpoint
ALTER TABLE "computers" ADD COLUMN "snapshot_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "computers" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "computers" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "max_running_forks" integer;--> statement-breakpoint
ALTER TABLE "computer_snapshots" ADD CONSTRAINT "computer_snapshots_computer_id_computers_id_fk" FOREIGN KEY ("computer_id") REFERENCES "public"."computers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "computer_snapshots_computer_idx" ON "computer_snapshots" USING btree ("computer_id");--> statement-breakpoint
ALTER TABLE "computers" ADD CONSTRAINT "computers_fork_of_computers_id_fk" FOREIGN KEY ("fork_of") REFERENCES "public"."computers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computers" ADD CONSTRAINT "computers_snapshot_id_computer_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."computer_snapshots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "computers_main_unique" ON "computers" USING btree ("membership_id") WHERE "computers"."fork_of" IS NULL;--> statement-breakpoint
CREATE INDEX "computers_membership_idx" ON "computers" USING btree ("membership_id");--> statement-breakpoint
CREATE INDEX "computers_fork_of_idx" ON "computers" USING btree ("fork_of");--> statement-breakpoint
CREATE INDEX "computers_snapshot_idx" ON "computers" USING btree ("snapshot_id");--> statement-breakpoint
ALTER TABLE "computers" ADD CONSTRAINT "computers_label" CHECK (char_length("computers"."label") BETWEEN 1 AND 100);--> statement-breakpoint
ALTER TABLE "computers" ADD CONSTRAINT "computers_fork" CHECK ("computers"."fork_of" IS NULL OR ("computers"."snapshot_due_at" IS NULL AND "computers"."last_used_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_max_running_forks" CHECK ("organizations"."max_running_forks" >= 0);--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_failed_step" CHECK ("tool_calls"."failed_step" IN ('snapshot', 'create', 'connect', 'sync', 'screenshot', 'act', 'cdp', 'exec', 'download'));