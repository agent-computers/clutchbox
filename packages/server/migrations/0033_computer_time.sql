CREATE TABLE "computer_time" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "computer_time_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"membership_id" bigint NOT NULL,
	"month" date NOT NULL,
	"size" text NOT NULL,
	"account" text NOT NULL,
	"run_seconds" integer DEFAULT 0 NOT NULL,
	"pauses" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "computer_time_month_unique" UNIQUE("membership_id","month","size","account"),
	CONSTRAINT "computer_time_size" CHECK ("computer_time"."size" IN ('1x', '2x', '4x')),
	CONSTRAINT "computer_time_account" CHECK ("computer_time"."account" IN ('deployment', 'organization')),
	CONSTRAINT "computer_time_counts" CHECK ("computer_time"."run_seconds" >= 0 AND "computer_time"."pauses" >= 0)
);
--> statement-breakpoint
ALTER TABLE "computer_time" ADD CONSTRAINT "computer_time_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- computer_usage counted seconds of the smallest size, snapshots and larger sizes included at their price, so each
-- month copies as that many seconds of 1x with no pauses: priced the same, with minutes a little over what ran.
INSERT INTO "computer_time" ("membership_id", "month", "size", "account", "run_seconds")
SELECT "membership_id", "month", '1x', 'deployment', "used_seconds" FROM "computer_usage" WHERE "used_seconds" > 0
UNION ALL
SELECT "membership_id", "month", '1x', 'organization', "own_account_seconds" FROM "computer_usage" WHERE "own_account_seconds" > 0;
