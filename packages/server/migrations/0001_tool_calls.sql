CREATE TABLE "tool_calls" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tool_calls_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" text NOT NULL,
	"client_id" text NOT NULL,
	"computer_session_id" bigint,
	"tool" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"error" text,
	"failed_step" text,
	"error_class" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_calls_failed_step" CHECK ("tool_calls"."failed_step" IN ('create', 'connect', 'sync', 'screenshot', 'act', 'cdp', 'exec', 'download')),
	CONSTRAINT "tool_calls_error" CHECK ("tool_calls"."error" ~ '^[a-z][a-z_]{0,39}$'),
	CONSTRAINT "tool_calls_error_class" CHECK (char_length("tool_calls"."error_class") <= 100)
);
--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_computer_session_id_computer_sessions_id_fk" FOREIGN KEY ("computer_session_id") REFERENCES "public"."computer_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_calls_user_started_idx" ON "tool_calls" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "tool_calls_started_idx" ON "tool_calls" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "tool_calls_client_idx" ON "tool_calls" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "tool_calls_computer_session_idx" ON "tool_calls" USING btree ("computer_session_id");