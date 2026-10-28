CREATE TABLE "provider_accounts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "provider_accounts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_public_id" text NOT NULL,
	"provider" text NOT NULL,
	"sealed_api_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_accounts_organization_public_id_unique" UNIQUE("organization_public_id"),
	CONSTRAINT "provider_accounts_provider" CHECK ("provider_accounts"."provider" IN ('e2b'))
);
--> statement-breakpoint
ALTER TABLE "computer_usage" ADD COLUMN "own_account_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_organization_public_id_organizations_public_id_fk" FOREIGN KEY ("organization_public_id") REFERENCES "public"."organizations"("public_id") ON DELETE cascade ON UPDATE no action;