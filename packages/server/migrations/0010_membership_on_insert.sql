-- While per-user tables move to memberships (schema.ts, memberships), a row inserted without membership_id takes the
-- person's oldest membership, so code that does not write it yet still fills it. Dropped once every write names it.
CREATE FUNCTION set_membership_from_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.membership_id IS NULL THEN
    SELECT id INTO NEW.membership_id FROM memberships WHERE user_id = NEW.user_id ORDER BY id LIMIT 1;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "computers_membership_on_insert" BEFORE INSERT ON "computers" FOR EACH ROW EXECUTE FUNCTION set_membership_from_user();
--> statement-breakpoint
CREATE TRIGGER "computer_sessions_membership_on_insert" BEFORE INSERT ON "computer_sessions" FOR EACH ROW EXECUTE FUNCTION set_membership_from_user();
--> statement-breakpoint
CREATE TRIGGER "tool_calls_membership_on_insert" BEFORE INSERT ON "tool_calls" FOR EACH ROW EXECUTE FUNCTION set_membership_from_user();
--> statement-breakpoint
CREATE TRIGGER "connected_browsers_membership_on_insert" BEFORE INSERT ON "connected_browsers" FOR EACH ROW EXECUTE FUNCTION set_membership_from_user();
--> statement-breakpoint
CREATE TRIGGER "captures_membership_on_insert" BEFORE INSERT ON "captures" FOR EACH ROW EXECUTE FUNCTION set_membership_from_user();
--> statement-breakpoint
CREATE TRIGGER "sync_revocations_membership_on_insert" BEFORE INSERT ON "sync_revocations" FOR EACH ROW EXECUTE FUNCTION set_membership_from_user();
--> statement-breakpoint
CREATE TRIGGER "sync_settings_membership_on_insert" BEFORE INSERT ON "sync_settings" FOR EACH ROW EXECUTE FUNCTION set_membership_from_user();
--> statement-breakpoint
CREATE TRIGGER "computer_usage_membership_on_insert" BEFORE INSERT ON "computer_usage" FOR EACH ROW EXECUTE FUNCTION set_membership_from_user();
--> statement-breakpoint
CREATE TRIGGER "setups_membership_on_insert" BEFORE INSERT ON "setups" FOR EACH ROW EXECUTE FUNCTION set_membership_from_user();
