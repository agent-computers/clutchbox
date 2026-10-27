ALTER TABLE "computer_sessions" ALTER COLUMN "client_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "computer_sessions" ADD COLUMN "api_key_id" text;--> statement-breakpoint
ALTER TABLE "computer_sessions" ADD COLUMN "cdp_token_hash" text;--> statement-breakpoint
ALTER TABLE "computer_sessions" ADD CONSTRAINT "computer_sessions_api_key_id_apikey_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."apikey"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "computer_sessions_api_key_idx" ON "computer_sessions" USING btree ("api_key_id");--> statement-breakpoint
ALTER TABLE "computer_sessions" ADD CONSTRAINT "computer_sessions_cdp_token_hash_unique" UNIQUE("cdp_token_hash");--> statement-breakpoint
ALTER TABLE "computer_sessions" ADD CONSTRAINT "computer_sessions_agent" CHECK (("computer_sessions"."client_id" IS NULL) <> ("computer_sessions"."api_key_id" IS NULL));