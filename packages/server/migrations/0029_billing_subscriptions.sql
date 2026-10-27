CREATE TABLE "billing_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"plan" text NOT NULL,
	"reference_id" text NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"status" text DEFAULT 'incomplete' NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"trial_start" timestamp with time zone,
	"trial_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false,
	"cancel_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"seats" integer,
	"billing_interval" text,
	"stripe_schedule_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_subscriptions_status" CHECK ("billing_subscriptions"."status" IN ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused'))
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "auth_user" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_reference_id_organizations_public_id_fk" FOREIGN KEY ("reference_id") REFERENCES "public"."organizations"("public_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_subscriptions_reference_id_idx" ON "billing_subscriptions" USING btree ("reference_id");--> statement-breakpoint
CREATE INDEX "billing_subscriptions_stripe_subscription_id_idx" ON "billing_subscriptions" USING btree ("stripe_subscription_id");