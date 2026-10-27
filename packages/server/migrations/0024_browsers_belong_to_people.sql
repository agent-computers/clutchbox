-- A connected browser belongs to the person and syncs to each of their organizations it has sites for. Expand only:
-- the code already deployed still writes membership_id and never user_id, which the code after this fills from the
-- membership when it finds a row without one. Existing browsers keep syncing to the membership they connected in.
CREATE TABLE "browser_memberships" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "browser_memberships_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"connected_browser_id" bigint NOT NULL,
	"membership_id" bigint NOT NULL,
	"last_synced_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_memberships_browser_membership_unique" UNIQUE("connected_browser_id","membership_id")
);
--> statement-breakpoint
ALTER TABLE "connected_browsers" DROP CONSTRAINT "connected_browsers_membership_id_memberships_id_fk";
--> statement-breakpoint
ALTER TABLE "connected_browsers" ALTER COLUMN "membership_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connected_browsers" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "browser_memberships" ADD CONSTRAINT "browser_memberships_connected_browser_id_connected_browsers_id_fk" FOREIGN KEY ("connected_browser_id") REFERENCES "public"."connected_browsers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_memberships" ADD CONSTRAINT "browser_memberships_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "browser_memberships_membership_idx" ON "browser_memberships" USING btree ("membership_id");--> statement-breakpoint
ALTER TABLE "connected_browsers" ADD CONSTRAINT "connected_browsers_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connected_browsers" ADD CONSTRAINT "connected_browsers_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connected_browsers_user_idx" ON "connected_browsers" USING btree ("user_id");--> statement-breakpoint
UPDATE "connected_browsers" SET "user_id" = "memberships"."user_id" FROM "memberships" WHERE "memberships"."id" = "connected_browsers"."membership_id" AND "connected_browsers"."user_id" IS NULL;--> statement-breakpoint
INSERT INTO "browser_memberships" ("connected_browser_id", "membership_id", "last_synced_at", "removed_at", "created_at", "updated_at") SELECT "id", "membership_id", "last_synced_at", "disconnected_at", "created_at", "updated_at" FROM "connected_browsers" WHERE "membership_id" IS NOT NULL ON CONFLICT DO NOTHING;
