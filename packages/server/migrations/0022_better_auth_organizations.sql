CREATE TABLE "organization_invitations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "organization_invitations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"organization_public_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"inviter_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_invitations_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "organization_invitations_role" CHECK ("organization_invitations"."role" IN ('owner', 'admin', 'member')),
	CONSTRAINT "organization_invitations_status" CHECK ("organization_invitations"."status" IN ('pending', 'accepted', 'rejected', 'canceled'))
);
--> statement-breakpoint
CREATE TABLE "apikey" (
	"id" text PRIMARY KEY NOT NULL,
	"config_id" text DEFAULT 'default' NOT NULL,
	"name" text,
	"start" text,
	"reference_id" text NOT NULL,
	"prefix" text,
	"key" text NOT NULL,
	"refill_interval" integer,
	"refill_amount" integer,
	"last_refill_at" timestamp with time zone,
	"enabled" boolean DEFAULT true,
	"rate_limit_enabled" boolean DEFAULT true,
	"rate_limit_time_window" integer,
	"rate_limit_max" integer,
	"request_count" integer DEFAULT 0,
	"remaining" integer,
	"last_request" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"permissions" text,
	"metadata" text,
	CONSTRAINT "apikey_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "memberships" DROP CONSTRAINT "memberships_organization_user_unique";--> statement-breakpoint
-- The old invitations and api_keys tables, and memberships.organization_id, stay until the next release drops them:
-- the release before this one still uses them while this migration runs. Its membership inserts set only
-- organization_id, so a trigger fills the public ID for them until then.
ALTER TABLE "memberships" ADD COLUMN "organization_public_id" text;--> statement-breakpoint
UPDATE "memberships" SET "organization_public_id" = "organizations"."public_id" FROM "organizations" WHERE "organizations"."id" = "memberships"."organization_id";--> statement-breakpoint
CREATE FUNCTION "memberships_fill_organization_public_id"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."organization_public_id" IS NULL THEN
    SELECT "public_id" INTO NEW."organization_public_id" FROM "organizations" WHERE "id" = NEW."organization_id";
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "memberships_fill_organization_public_id" BEFORE INSERT ON "memberships" FOR EACH ROW EXECUTE FUNCTION "memberships_fill_organization_public_id"();--> statement-breakpoint
ALTER TABLE "memberships" ALTER COLUMN "organization_public_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "logo" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "metadata" text;--> statement-breakpoint
UPDATE "organizations" SET "slug" = "public_id";--> statement-breakpoint
ALTER TABLE "auth_session" ADD COLUMN "active_organization_id" text;--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_organization_public_id_organizations_public_id_fk" FOREIGN KEY ("organization_public_id") REFERENCES "public"."organizations"("public_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_inviter_id_auth_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apikey" ADD CONSTRAINT "apikey_reference_id_organizations_public_id_fk" FOREIGN KEY ("reference_id") REFERENCES "public"."organizations"("public_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organization_invitations_organization_idx" ON "organization_invitations" USING btree ("organization_public_id");--> statement-breakpoint
CREATE INDEX "organization_invitations_inviter_idx" ON "organization_invitations" USING btree ("inviter_id");--> statement-breakpoint
CREATE INDEX "organization_invitations_email_idx" ON "organization_invitations" USING btree ("email");--> statement-breakpoint
CREATE INDEX "apikey_config_id_idx" ON "apikey" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX "apikey_reference_id_idx" ON "apikey" USING btree ("reference_id");--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_public_id_organizations_public_id_fk" FOREIGN KEY ("organization_public_id") REFERENCES "public"."organizations"("public_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_user_unique" UNIQUE("organization_public_id","user_id");--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_slug_unique" UNIQUE("slug");