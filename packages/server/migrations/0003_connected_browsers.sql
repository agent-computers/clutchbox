CREATE TABLE "connected_browsers" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "connected_browsers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"user_id" text NOT NULL,
	"authorization_code_id" text NOT NULL,
	"browser" text,
	"platform" text,
	"last_synced_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connected_browsers_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "connected_browsers_authorization_code_id_unique" UNIQUE("authorization_code_id"),
	CONSTRAINT "connected_browsers_browser" CHECK ("connected_browsers"."browser" IN ('chrome', 'edge', 'opera')),
	CONSTRAINT "connected_browsers_platform" CHECK ("connected_browsers"."platform" IN ('macos', 'windows', 'linux', 'chromeos'))
);
--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "connected_browser_id" bigint;--> statement-breakpoint
ALTER TABLE "connected_browsers" ADD CONSTRAINT "connected_browsers_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connected_browsers_user_idx" ON "connected_browsers" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_connected_browser_id_connected_browsers_id_fk" FOREIGN KEY ("connected_browser_id") REFERENCES "public"."connected_browsers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "captures_connected_browser_idx" ON "captures" USING btree ("connected_browser_id");--> statement-breakpoint
ALTER TABLE "oauth_client" ADD CONSTRAINT "oauth_client_skip_consent" CHECK ("oauth_client"."skip_consent" is not true or "oauth_client"."id" = 'agent-computers-extension');