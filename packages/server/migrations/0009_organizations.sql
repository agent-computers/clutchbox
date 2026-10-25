CREATE TABLE "memberships" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "memberships_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"organization_id" bigint NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "memberships_organization_user_unique" UNIQUE("organization_id","user_id"),
	CONSTRAINT "memberships_role" CHECK ("memberships"."role" IN ('owner', 'admin', 'member'))
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "organizations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"name" text NOT NULL,
	"personal_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "organizations_personal_user_id_unique" UNIQUE("personal_user_id"),
	CONSTRAINT "organizations_name" CHECK (char_length("organizations"."name") BETWEEN 1 AND 100)
);
--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "membership_id" bigint;--> statement-breakpoint
ALTER TABLE "computer_sessions" ADD COLUMN "membership_id" bigint;--> statement-breakpoint
ALTER TABLE "computer_usage" ADD COLUMN "membership_id" bigint;--> statement-breakpoint
ALTER TABLE "computers" ADD COLUMN "membership_id" bigint;--> statement-breakpoint
ALTER TABLE "connected_browsers" ADD COLUMN "membership_id" bigint;--> statement-breakpoint
ALTER TABLE "setups" ADD COLUMN "membership_id" bigint;--> statement-breakpoint
ALTER TABLE "sync_revocations" ADD COLUMN "membership_id" bigint;--> statement-breakpoint
ALTER TABLE "sync_settings" ADD COLUMN "membership_id" bigint;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD COLUMN "membership_id" bigint;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_personal_user_id_auth_user_id_fk" FOREIGN KEY ("personal_user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_sessions" ADD CONSTRAINT "computer_sessions_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_usage" ADD CONSTRAINT "computer_usage_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computers" ADD CONSTRAINT "computers_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connected_browsers" ADD CONSTRAINT "connected_browsers_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setups" ADD CONSTRAINT "setups_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_revocations" ADD CONSTRAINT "sync_revocations_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_settings" ADD CONSTRAINT "sync_settings_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "captures_membership_idx" ON "captures" USING btree ("membership_id");--> statement-breakpoint
CREATE INDEX "computer_sessions_membership_idx" ON "computer_sessions" USING btree ("membership_id");--> statement-breakpoint
CREATE INDEX "computer_usage_membership_idx" ON "computer_usage" USING btree ("membership_id");--> statement-breakpoint
CREATE INDEX "computers_membership_idx" ON "computers" USING btree ("membership_id");--> statement-breakpoint
CREATE INDEX "connected_browsers_membership_idx" ON "connected_browsers" USING btree ("membership_id");--> statement-breakpoint
CREATE INDEX "setups_membership_idx" ON "setups" USING btree ("membership_id");--> statement-breakpoint
CREATE INDEX "sync_revocations_membership_idx" ON "sync_revocations" USING btree ("membership_id");--> statement-breakpoint
CREATE INDEX "sync_settings_membership_idx" ON "sync_settings" USING btree ("membership_id");--> statement-breakpoint
CREATE INDEX "tool_calls_membership_idx" ON "tool_calls" USING btree ("membership_id");