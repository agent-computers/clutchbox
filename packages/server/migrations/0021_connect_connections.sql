CREATE TABLE "connections" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "connections_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"client_id" text NOT NULL,
	"membership_id" bigint NOT NULL,
	"external_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connections_client_membership_unique" UNIQUE("client_id","membership_id"),
	CONSTRAINT "connections_external_user_id" CHECK (char_length("connections"."external_user_id") BETWEEN 1 AND 255)
);
--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connections_membership_idx" ON "connections" USING btree ("membership_id");