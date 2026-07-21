-- Audit history is accounting and security evidence. Application writes may append events, but
-- may never rewrite or remove them. Whole-installation restore is the only production exception:
-- migration 0044 binds that authority to the exact active restore operation and PostgreSQL
-- transaction, so a caller-controlled setting alone cannot bypass this trigger.
CREATE FUNCTION dg_chat_enforce_audit_event_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog
AS $$
DECLARE
  restore_authorized boolean:=false;
  test_transaction text;
  test_authorized boolean:=false;
BEGIN
  EXECUTE format('SELECT %I.dg_chat_restore_transaction_authorized($1)',TG_TABLE_SCHEMA)
    INTO restore_authorized USING TG_TABLE_SCHEMA::name;
  IF restore_authorized THEN RETURN NULL; END IF;

  -- Test teardown occasionally needs to reset an isolated database between adversarial cases.
  -- This second path is deliberately outside the production trust boundary: only a PostgreSQL
  -- superuser in a helper-owned disposable database can request it, and the value must name this
  -- exact transaction. A transaction-local GUC cannot survive commit, rollback, or pool reuse.
  test_transaction:=current_setting('dg_chat.audit_test_maintenance_transaction',true);
  IF test_transaction IS NOT NULL AND test_transaction ~ '^[0-9]+$'
    AND test_transaction=pg_current_xact_id()::text
    AND current_database() ~ '^dgchat_ci_[a-z0-9_]{1,30}_[a-z][a-z0-9_]{0,23}$'
  THEN
    SELECT role.rolsuper AND EXISTS(
      SELECT 1 FROM pg_locks held
      WHERE held.locktype='advisory'
        AND held.pid=pg_backend_pid()
        AND held.granted=true
        AND held.mode='ExclusiveLock'
        AND held.classid::bigint =
          ((hashtext('dg-chat-audit-test-maintenance')::bigint >> 32) & 4294967295)
        AND held.objid::bigint =
          (hashtext('dg-chat-audit-test-maintenance')::bigint & 4294967295)
        AND held.objsubid=1
    ) INTO test_authorized
    FROM pg_roles role WHERE role.rolname=current_user;
  END IF;
  IF COALESCE(test_authorized,false) THEN RETURN NULL; END IF;

  RAISE EXCEPTION 'audit_events is append-only'
    USING ERRCODE='55000',
      HINT='Append a new audit event instead of modifying immutable history.';
END;
$$;

CREATE TRIGGER dg_chat_audit_events_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION dg_chat_enforce_audit_event_immutability();

-- Tests invoke this only inside an explicit transaction. Revoking the helper from PUBLIC makes
-- the superuser requirement visible in the database ACL as well as enforcing it in the body.
CREATE FUNCTION dg_chat_begin_audit_test_maintenance()
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path=pg_catalog
AS $$
DECLARE
  caller_is_superuser boolean:=false;
BEGIN
  SELECT role.rolsuper INTO caller_is_superuser
  FROM pg_roles role WHERE role.rolname=current_user;
  IF NOT COALESCE(caller_is_superuser,false)
    OR current_database() !~ '^dgchat_ci_[a-z0-9_]{1,30}_[a-z][a-z0-9_]{0,23}$'
  THEN
    RAISE EXCEPTION 'audit test maintenance is restricted to disposable test databases'
      USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('dg-chat-audit-test-maintenance'));
  PERFORM set_config(
    'dg_chat.audit_test_maintenance_transaction',
    pg_current_xact_id()::text,
    true
  );
END;
$$;
REVOKE ALL ON FUNCTION dg_chat_begin_audit_test_maintenance() FROM PUBLIC;
