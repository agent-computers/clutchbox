-- Profiles: each connected browser is its own Chrome profile on the member's computers. Expand only: the code already
-- deployed keeps using captures and the applied_capture columns of computers and computer_snapshots, which the code
-- after this never reads, and a later release drops them. Each member's capture moves to the browser that sent it, and
-- each computer's and snapshot's applied state becomes that browser's profile in the directory its Chrome already runs
-- ('default'), so existing sign-ins stay without a reset. Where no browser is recorded, the member's most recently
-- synced one that still syncs takes both; a computer with synced sites but no such browser goes to the member's most
-- recently synced one, so its next open signs those sites out.
CREATE TABLE "browser_captures" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "browser_captures_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"membership_id" bigint NOT NULL,
	"connected_browser_id" bigint NOT NULL,
	"capture_id" uuid NOT NULL,
	"digest" text NOT NULL,
	"cookie_count" integer NOT NULL,
	"sealed" text NOT NULL,
	"sealed_scope" text,
	"completed_at" timestamp with time zone NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_captures_membership_browser_unique" UNIQUE("membership_id","connected_browser_id")
);
--> statement-breakpoint
CREATE TABLE "computer_profiles" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "computer_profiles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"computer_id" bigint,
	"snapshot_id" bigint,
	"connected_browser_id" bigint NOT NULL,
	"chrome_profile" text NOT NULL,
	"applied_capture_digest" text,
	"applied_capture_at" timestamp with time zone,
	"synced_sites" text[] DEFAULT '{}'::text[] NOT NULL,
	"applied_capture" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "computer_profiles_computer_browser_unique" UNIQUE("computer_id","connected_browser_id"),
	CONSTRAINT "computer_profiles_computer_chrome_profile_unique" UNIQUE("computer_id","chrome_profile"),
	CONSTRAINT "computer_profiles_snapshot_browser_unique" UNIQUE("snapshot_id","connected_browser_id"),
	CONSTRAINT "computer_profiles_owner" CHECK (("computer_profiles"."computer_id" IS NULL) <> ("computer_profiles"."snapshot_id" IS NULL)),
	CONSTRAINT "computer_profiles_chrome_profile" CHECK ("computer_profiles"."chrome_profile" ~ '^[a-z0-9_]{1,64}$')
);
--> statement-breakpoint
ALTER TABLE "computer_sessions" ADD COLUMN "connected_browser_id" bigint;--> statement-breakpoint
ALTER TABLE "browser_captures" ADD CONSTRAINT "browser_captures_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_captures" ADD CONSTRAINT "browser_captures_connected_browser_id_connected_browsers_id_fk" FOREIGN KEY ("connected_browser_id") REFERENCES "public"."connected_browsers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_profiles" ADD CONSTRAINT "computer_profiles_computer_id_computers_id_fk" FOREIGN KEY ("computer_id") REFERENCES "public"."computers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_profiles" ADD CONSTRAINT "computer_profiles_snapshot_id_computer_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."computer_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_profiles" ADD CONSTRAINT "computer_profiles_connected_browser_id_connected_browsers_id_fk" FOREIGN KEY ("connected_browser_id") REFERENCES "public"."connected_browsers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "browser_captures_connected_browser_idx" ON "browser_captures" USING btree ("connected_browser_id");--> statement-breakpoint
CREATE INDEX "computer_profiles_connected_browser_idx" ON "computer_profiles" USING btree ("connected_browser_id");--> statement-breakpoint
ALTER TABLE "computer_sessions" ADD CONSTRAINT "computer_sessions_connected_browser_id_connected_browsers_id_fk" FOREIGN KEY ("connected_browser_id") REFERENCES "public"."connected_browsers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "computer_sessions_connected_browser_idx" ON "computer_sessions" USING btree ("connected_browser_id");--> statement-breakpoint
INSERT INTO "browser_captures" ("membership_id", "connected_browser_id", "capture_id", "digest", "cookie_count", "sealed", "sealed_scope", "completed_at", "uploaded_at", "created_at", "updated_at") SELECT "c"."membership_id", "o"."browser", "c"."capture_id", "c"."digest", "c"."cookie_count", "c"."sealed", "c"."sealed_scope", "c"."completed_at", "c"."uploaded_at", "c"."created_at", "c"."updated_at" FROM "captures" "c" CROSS JOIN LATERAL (SELECT coalesce("c"."connected_browser_id", (SELECT "bm"."connected_browser_id" FROM "browser_memberships" "bm" INNER JOIN "connected_browsers" "cb" ON "cb"."id" = "bm"."connected_browser_id" WHERE "bm"."membership_id" = "c"."membership_id" AND "bm"."removed_at" IS NULL AND "cb"."disconnected_at" IS NULL ORDER BY "bm"."last_synced_at" DESC NULLS LAST, "bm"."id" DESC LIMIT 1)) AS "browser") "o" WHERE "o"."browser" IS NOT NULL ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "computer_profiles" ("computer_id", "connected_browser_id", "chrome_profile", "applied_capture_digest", "applied_capture_at", "synced_sites", "applied_capture") SELECT "c"."id", "o"."browser", 'default', "c"."applied_capture_digest", "c"."applied_capture_at", "c"."synced_sites", "c"."applied_capture" FROM "computers" "c" CROSS JOIN LATERAL (SELECT coalesce((SELECT "x"."connected_browser_id" FROM "captures" "x" WHERE "x"."membership_id" = "c"."membership_id"), (SELECT "bm"."connected_browser_id" FROM "browser_memberships" "bm" INNER JOIN "connected_browsers" "cb" ON "cb"."id" = "bm"."connected_browser_id" WHERE "bm"."membership_id" = "c"."membership_id" AND "bm"."removed_at" IS NULL AND "cb"."disconnected_at" IS NULL ORDER BY "bm"."last_synced_at" DESC NULLS LAST, "bm"."id" DESC LIMIT 1), (SELECT "bm"."connected_browser_id" FROM "browser_memberships" "bm" WHERE "bm"."membership_id" = "c"."membership_id" ORDER BY "bm"."last_synced_at" DESC NULLS LAST, "bm"."id" DESC LIMIT 1)) AS "browser") "o" WHERE "o"."browser" IS NOT NULL AND ("c"."applied_capture_digest" IS NOT NULL OR cardinality("c"."synced_sites") > 0);--> statement-breakpoint
INSERT INTO "computer_profiles" ("snapshot_id", "connected_browser_id", "chrome_profile", "applied_capture_digest", "applied_capture_at", "synced_sites", "applied_capture") SELECT "s"."id", "o"."browser", 'default', "s"."applied_capture_digest", "s"."applied_capture_at", "s"."synced_sites", "s"."applied_capture" FROM "computer_snapshots" "s" INNER JOIN "computers" "c" ON "c"."id" = "s"."computer_id" CROSS JOIN LATERAL (SELECT coalesce((SELECT "x"."connected_browser_id" FROM "captures" "x" WHERE "x"."membership_id" = "c"."membership_id"), (SELECT "bm"."connected_browser_id" FROM "browser_memberships" "bm" INNER JOIN "connected_browsers" "cb" ON "cb"."id" = "bm"."connected_browser_id" WHERE "bm"."membership_id" = "c"."membership_id" AND "bm"."removed_at" IS NULL AND "cb"."disconnected_at" IS NULL ORDER BY "bm"."last_synced_at" DESC NULLS LAST, "bm"."id" DESC LIMIT 1), (SELECT "bm"."connected_browser_id" FROM "browser_memberships" "bm" WHERE "bm"."membership_id" = "c"."membership_id" ORDER BY "bm"."last_synced_at" DESC NULLS LAST, "bm"."id" DESC LIMIT 1)) AS "browser") "o" WHERE "o"."browser" IS NOT NULL AND ("s"."applied_capture_digest" IS NOT NULL OR cardinality("s"."synced_sites") > 0);
